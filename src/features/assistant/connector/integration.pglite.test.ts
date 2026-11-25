// @vitest-environment node
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Db } from "@/db"
import { accessTokens } from "@/db/schema"
import { createRoomRegistry } from "@/features/collab/room-session"
import { loadRoomScene, saveRoomScene } from "@/features/collab/scene-store"
import { activateServerWriter } from "@/features/drawings/writer-mode"
import { registerAssistantTools } from "../mcp"
import { createAssistantSceneStore } from "../scene"
import { createAssistantStore } from "../store"
import { createAssistantTestDb, seedAssistantTest } from "../test-support"
import { AssistantMcpClient } from "./client"
import type { Executor } from "./codex"
import { runConnector } from "./runner"
import type { ConnectorState, StateStore } from "./state"

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await createAssistantTestDb())
}, 30_000)
afterAll(async () => close?.())

const until = async (condition: () => Promise<boolean> | boolean) => {
  for (let count = 0; count < 400; count++) {
    if (await condition()) return
    await delay(5)
  }
  throw new Error("Connector test condition timed out")
}
const contextOf = (prompt: string) =>
  JSON.parse(prompt.match(/exact context: (\{[^\n]+\})\./)?.[1] ?? "{}")

async function setup(
  intercept?: (
    request: Request,
    send: () => Promise<Response>,
  ) => Promise<Response>,
) {
  const seed = await seedAssistantTest(db)
  await activateServerWriter(db, seed.ownerId, {
    id: seed.drawingId,
    expectedRevision: 0,
    snapshot: { data: "{}", files: [] },
  })
  const store = createAssistantStore(db)
  const conversation = await store.getOrCreateConversation(seed.ownerId, {
    drawingId: seed.drawingId,
  })
  const { run } = await store.sendInstruction(seed.ownerId, {
    conversationId: conversation.id,
    requestId: "start",
    body: "Add an API node",
  })
  const rooms = createRoomRegistry(
    (id) => loadRoomScene(db, id),
    (id, elements, settings) => saveRoomScene(db, id, elements, settings),
  )
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "test", version: "1" })
    registerAssistantTools(server, db, seed.principal, rooms)
    return server
  })
  const fetcher: typeof fetch = async (url, init) => {
    const request = new Request(url, init)
    expect(request.headers.get("authorization")).toBe("Bearer test-credential")
    return intercept
      ? intercept(request, () => handler.fetch(request))
      : handler.fetch(request)
  }
  const client = new AssistantMcpClient(
    "http://localhost/api/mcp",
    "test-credential",
    fetcher,
  )
  const data: ConnectorState = {
    version: 1,
    endpoint: "http://localhost/api/mcp",
    workerId: randomUUID(),
    threads: {},
    pending: {},
  }
  const state: StateStore = {
    data,
    async update(change) {
      change(data)
    },
  }
  const stop = new AbortController()
  const status = () =>
    store.getConversation(seed.ownerId, { conversationId: conversation.id })
  const start = (execute: Executor) =>
    runConnector({
      client,
      state,
      execute,
      signal: stop.signal,
      pollMs: 5,
      monitorMs: 5,
      heartbeatMs: 10,
    })
  const edit: Executor = async ({ prompt }, { onThread }) => {
    await onThread("test-codex-thread")
    const context = contextOf(prompt)
    const scene = await client.call<{ base: Record<string, unknown> }>(
      "assistant_read_scene",
      context,
    )
    await client.call("assistant_commit_edit", {
      ...context,
      requestId: "add-api",
      summary: "Add API",
      base: scene.base,
      add: [{ type: "rectangle", label: "API" }],
    })
    return { kind: "completed", body: "Added the API node." }
  }
  return {
    ...seed,
    store,
    rooms,
    conversation,
    run,
    client,
    state,
    stop,
    status,
    start,
    edit,
  }
}

test("the connector completes a browser-free task through real MCP and persists its thread", async () => {
  const {
    start,
    edit,
    status,
    stop,
    state,
    drawingId,
    ownerId,
    conversation,
    rooms,
  } = await setup()
  const running = start(edit)
  try {
    await until(async () => (await status()).latestRun?.status === "completed")
  } finally {
    stop.abort()
    await running
  }
  expect(
    (await loadRoomScene(db, drawingId)).elements.some(
      (el) => el.type === "rectangle",
    ),
  ).toBe(true)
  expect(
    await createAssistantSceneStore(db, rooms).listOperations(
      ownerId,
      conversation.id,
    ),
  ).toHaveLength(1)
  expect(state.data.threads[conversation.id]).toBe("test-codex-thread")
  expect(state.data.pending).toEqual({})
})

test("pause stops execution before acknowledgement; resume starts with fresh controls and history", async () => {
  const data = await setup()
  let attempts = 0
  let interrupted = false
  const running = data.start(async (context, options) => {
    if (++attempts > 1) {
      expect(context.prompt).toContain('"controlVersion":3')
      return data.edit(context, options)
    }
    await new Promise<void>((resolve) =>
      options.signal.addEventListener(
        "abort",
        () => {
          interrupted = true
          resolve()
        },
        { once: true },
      ),
    )
    options.signal.throwIfAborted()
    throw new Error("unreachable")
  })
  try {
    await until(() => attempts === 1)
    await data.store.controlRun(data.ownerId, {
      conversationId: data.conversation.id,
      runId: data.run.id,
      requestId: "pause",
      command: "pause",
      expectedControlVersion: 1,
    })
    await until(
      async () =>
        (await data.status()).activeRun?.acknowledgedControlVersion === 2,
    )
    expect(interrupted).toBe(true)
    expect((await loadRoomScene(db, data.drawingId)).elements).toEqual([])
    await data.store.controlRun(data.ownerId, {
      conversationId: data.conversation.id,
      runId: data.run.id,
      requestId: "resume",
      command: "resume",
      expectedControlVersion: 2,
    })
    await until(
      async () => (await data.status()).latestRun?.status === "completed",
    )
    expect(attempts).toBe(2)
  } finally {
    data.stop.abort()
    await running
  }
})

test("an additional instruction interrupts the old model and restarts with its new message", async () => {
  const data = await setup()
  let attempts = 0
  const running = data.start(async (context, options) => {
    if (++attempts > 1) {
      expect(context.prompt).toContain("Make it blue")
      expect(context.prompt).toContain('"controlVersion":2')
      return data.edit(context, options)
    }
    await delay(10_000, undefined, { signal: options.signal })
    return { kind: "failed", body: "Should have stopped" }
  })
  try {
    await until(() => attempts === 1)
    await data.store.sendInstruction(data.ownerId, {
      conversationId: data.conversation.id,
      requestId: "followup",
      body: "Make it blue",
    })
    await until(
      async () => (await data.status()).latestRun?.status === "completed",
    )
    expect(attempts).toBe(2)
  } finally {
    data.stop.abort()
    await running
  }
})

test("an unknown final-report response is replayed from the journal without reexecuting the model", async () => {
  let reports = 0
  const data = await setup(async (request, send) => {
    const body = await request.clone().json()
    const response = await send()
    if (body.params?.name === "assistant_report" && ++reports === 1)
      throw new TypeError("Simulated lost response after commit")
    return response
  })
  let executions = 0
  const running = data.start(async (context, options) => {
    executions++
    return data.edit(context, options)
  })
  try {
    await until(
      () => reports >= 2 && Object.keys(data.state.data.pending).length === 0,
    )
  } finally {
    data.stop.abort()
    await running
  }
  expect(executions).toBe(1)
  expect(
    (
      await data.store.listMessages(data.ownerId, {
        conversationId: data.conversation.id,
      })
    ).items,
  ).toHaveLength(2)
})

test("startup connection failure retries; revoked credentials stop the active model", async () => {
  let connectionAttempts = 0
  const data = await setup(async (_request, send) => {
    if (++connectionAttempts < 3) throw new TypeError("Offline")
    return send()
  })
  let started = false
  let interrupted = false
  const running = data.start(async (_context, { signal }) => {
    started = true
    try {
      await delay(10_000, undefined, { signal })
    } finally {
      interrupted = signal.aborted
    }
    return { kind: "completed", body: "unexpected" }
  })
  const rejected = expect(running).rejects.toMatchObject({
    code: "credential_revoked",
  })
  await until(() => started)
  await db.delete(accessTokens).where(eq(accessTokens.id, data.tokenId))
  await rejected
  expect(interrupted).toBe(true)
  expect(data.state.data.pending).toEqual({})
})

test("a restarted process replays its journal using the original execution identity", async () => {
  let reports = 0
  let crash = () => {}
  const pollIds = new Set<string>(),
    reportIds = new Set<string>()
  const data = await setup(async (request, send) => {
    const body = await request.clone().json()
    if (body.params?.name === "assistant_poll")
      pollIds.add(body.params.arguments.workerId)
    const response = await send()
    if (body.params?.name === "assistant_report") {
      reportIds.add(body.params.arguments.workerId)
      if (++reports === 1) {
        crash()
        throw new TypeError("Process stopped after the server committed")
      }
    }
    return response
  })
  crash = () => data.stop.abort()
  await data.start(data.edit)
  expect(Object.keys(data.state.data.pending)).toHaveLength(1)
  const stop = new AbortController()
  let executed = false
  const running = runConnector({
    client: data.client,
    state: data.state,
    signal: stop.signal,
    execute: async () => {
      executed = true
      return { kind: "completed", body: "unexpected" }
    },
    pollMs: 5,
  })
  try {
    await until(() => Object.keys(data.state.data.pending).length === 0)
  } finally {
    stop.abort()
    await running
  }
  expect(executed).toBe(false)
  expect(pollIds.size).toBe(2)
  expect(reportIds.size).toBe(1)
  expect(
    (
      await data.store.listMessages(data.ownerId, {
        conversationId: data.conversation.id,
      })
    ).items,
  ).toHaveLength(2)
})

test("changing members stops before replaying another account's local journal", async () => {
  const data = await setup()
  await data.state.update((state) => {
    state.memberId = "different-member"
    state.pending.old = {
      conversationId: "old",
      runId: "old",
      workerId: "old-worker",
      generation: 1,
      controlVersion: 1,
      requestId: "old",
      kind: "completed",
      body: "Private old result",
    }
  })
  await expect(data.start(data.edit)).rejects.toMatchObject({
    code: "account_changed",
  })
  expect(data.state.data.pending.old.body).toBe("Private old result")
})

test("replacing a member's credential recovers an already-saved final report without executing again", async () => {
  let reports = 0
  let crash = () => {}
  const data = await setup(async (request, send) => {
    const body = await request.clone().json()
    const response = await send()
    if (body.params?.name === "assistant_report" && ++reports === 1) {
      crash()
      throw new TypeError("Stopped after the final report committed")
    }
    return response
  })
  crash = () => data.stop.abort()
  await data.start(data.edit)
  expect(Object.keys(data.state.data.pending)).toHaveLength(1)
  await db.delete(accessTokens).where(eq(accessTokens.id, data.tokenId))
  const credentialId = randomUUID()
  await db.insert(accessTokens).values({
    id: credentialId,
    userId: data.ownerId,
    name: "Replacement credential",
    tokenHash: randomUUID(),
    start: "exs_new",
  })
  data.principal.credentialId = credentialId
  const stop = new AbortController()
  let executed = false
  let failure: unknown
  const running = runConnector({
    client: data.client,
    state: data.state,
    signal: stop.signal,
    execute: async () => {
      executed = true
      return { kind: "failed", body: "Must not run" }
    },
    pollMs: 5,
  }).catch((error) => {
    failure = error
  })
  try {
    await until(() => {
      if (failure) throw failure
      return Object.keys(data.state.data.pending).length === 0
    })
  } finally {
    stop.abort()
    await running
  }
  expect(executed).toBe(false)
  expect(reports).toBe(2)
  expect((await data.status()).latestRun?.status).toBe("completed")
  expect(
    (
      await data.store.listMessages(data.ownerId, {
        conversationId: data.conversation.id,
      })
    ).items,
  ).toHaveLength(2)
})
