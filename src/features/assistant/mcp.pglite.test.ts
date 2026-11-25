// @vitest-environment node
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Db } from "@/db"
import { accessTokens, drawings } from "@/db/schema"
import { createRoomRegistry } from "@/features/collab/room-session"
import { loadRoomScene, saveRoomScene } from "@/features/collab/scene-store"
import { activateServerWriter } from "@/features/drawings/writer-mode"
import { registerAssistantTools } from "./mcp"
import { createAssistantStore } from "./store"
import { createAssistantTestDb, seedAssistantTest } from "./test-support"
import { createAssistantWorkerStore } from "./workers"

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await createAssistantTestDb())
}, 30_000)
afterAll(async () => close?.())

async function setup() {
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
    body: "Add a rectangle",
  })
  const rooms = createRoomRegistry(
    (id) => loadRoomScene(db, id),
    (id, elements, settings) => saveRoomScene(db, id, elements, settings),
  )
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "assistant-test", version: "1" })
    registerAssistantTools(server, db, seed.principal, rooms)
    return server
  })
  let id = 0
  const rpc = async (method: string, params: unknown) => {
    const response = await handler.fetch(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
    )
    const text = await response.text()
    const data = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? JSON.parse(
          text
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5) ?? "{}",
        )
      : JSON.parse(text)
    if (data.error) throw new Error(JSON.stringify(data.error))
    return data.result
  }
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await rpc("tools/call", {
      name,
      arguments: { workerId: seed.principal.workerId, ...args },
    })
    return JSON.parse(result.content[0].text)
  }
  return { ...seed, store, conversation, run, rpc, tool }
}

test("real stateless MCP exposes stable inputs and completes a durable background drawing task", async () => {
  const { tool, rpc, conversation, run, drawingId, ownerId } = await setup()
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  })
  expect(initialized.serverInfo.name).toBe("assistant-test")
  const { tools } = await rpc("tools/list", {})
  expect(tools.map((tool: { name: string }) => tool.name)).toContain(
    "assistant_commit_edit",
  )
  expect(
    tools.find((tool: { name: string }) => tool.name === "assistant_claim")
      .inputSchema.properties,
  ).not.toHaveProperty("userId")
  const poll = await tool("assistant_poll")
  expect(poll.protocolVersion).toBe(1)
  expect(poll.tasks).toHaveLength(1)
  expect(
    await createAssistantWorkerStore(db).connections(ownerId),
  ).toHaveLength(1)
  const input = { conversationId: conversation.id, runId: run.id }
  const claimed = await tool("assistant_claim", input)
  const work = {
    ...input,
    generation: claimed.leaseGeneration,
    controlVersion: claimed.controlVersion,
  }
  expect((await tool("assistant_work", input)).messages.items[0].body).toBe(
    "Add a rectangle",
  )
  expect(await tool("assistant_read_scene", work)).toMatchObject({
    error: { code: "input_unacknowledged" },
  })
  await tool("assistant_acknowledge", { ...work, throughSequence: 1 })
  const scene = await tool("assistant_read_scene", work)
  const receipt = await tool("assistant_commit_edit", {
    ...work,
    requestId: "draw",
    summary: "Add rectangle",
    base: scene.base,
    add: [{ type: "rectangle", label: "API" }],
  })
  expect(receipt.status).toBe("saved")
  expect(
    (await loadRoomScene(db, drawingId)).elements.some(
      (el) => el.type === "rectangle",
    ),
  ).toBe(true)
  expect(
    await tool("assistant_get_operation", {
      conversationId: conversation.id,
      requestId: "draw",
    }),
  ).toMatchObject({ id: receipt.id, sceneRevision: receipt.sceneRevision })
  await tool("assistant_report", {
    ...work,
    requestId: "result",
    kind: "completed",
    body: "Created API rectangle",
  })
  expect((await tool("assistant_poll")).tasks).toEqual([])
})

test("MCP returns structured stale-control and privacy errors without scene writes", async () => {
  const { tool, store, conversation, run, ownerId, otherId, drawingId } =
    await setup()
  const input = { conversationId: conversation.id, runId: run.id }
  await tool("assistant_claim", input)
  const work = { ...input, generation: 1, controlVersion: 1 }
  await tool("assistant_acknowledge", { ...work, throughSequence: 1 })
  const otherConversation = await store.getOrCreateConversation(otherId, {
    drawingId: (await seedAssistantTest(db)).teamId,
  })
  expect(
    await tool("assistant_claim", {
      conversationId: otherConversation.id,
      runId: run.id,
    }),
  ).toMatchObject({ error: { code: "not_found" } })
  await store.controlRun(ownerId, {
    ...input,
    command: "pause",
    expectedControlVersion: 1,
    requestId: "pause",
  })
  expect(
    await tool("assistant_commit_edit", {
      ...work,
      requestId: "late",
      summary: "Late",
      base: {},
      add: [{ type: "rectangle" }],
    }),
  ).toMatchObject({ error: { code: "stale_control" } })
  expect((await loadRoomScene(db, drawingId)).elements).toEqual([])
})

test("discovery hides unmanaged and trashed tasks; revocation immediately removes online presence", async () => {
  const { tool, ownerId, tokenId, drawingId, store, teamId } = await setup()
  const pending = await store.getOrCreateConversation(ownerId, {
    drawingId: teamId,
  })
  await store.sendInstruction(ownerId, {
    conversationId: pending.id,
    requestId: "other",
    body: "Not enabled",
  })
  expect((await tool("assistant_poll")).tasks).toHaveLength(1)
  await db
    .update(drawings)
    .set({ deletedAt: new Date() })
    .where(eq(drawings.id, drawingId))
  expect((await tool("assistant_poll")).tasks).toEqual([])
  await db.delete(accessTokens).where(eq(accessTokens.id, tokenId))
  expect(await tool("assistant_poll")).toMatchObject({
    error: { code: "credential_revoked" },
  })
  expect(await createAssistantWorkerStore(db).connections(ownerId)).toEqual([])
})
