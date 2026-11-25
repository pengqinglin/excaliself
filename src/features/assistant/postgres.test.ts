// @vitest-environment node
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { and, eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "@/db"
import * as schema from "@/db/schema"
import {
  assistantConversations,
  assistantEvents,
  assistantMessages,
  assistantRuns,
  drawingFiles,
  drawings,
  users,
} from "@/db/schema"
import { revokeAccessToken } from "@/features/access-tokens/tokens"
import { createRoomRegistry } from "@/features/collab/room-session"
import { loadRoomScene, saveRoomScene } from "@/features/collab/scene-store"
import { writeDrawingScene } from "@/features/drawings/scene-write"
import { activateServerWriter } from "@/features/drawings/writer-mode"
import { trashDrawingUnit } from "@/features/trash/trash"
import { createAssistantRevertStore } from "./revert"
import { createAssistantSceneStore } from "./scene"
import { createAssistantStore } from "./store"
import { seedAssistantTest } from "./test-support"

// Opt in with an isolated database, never the application's DATABASE_URL.
const connectionString = process.env.ASSISTANT_TEST_DATABASE_URL
if (connectionString && !new URL(connectionString).pathname.endsWith("_test"))
  throw new Error(
    "ASSISTANT_TEST_DATABASE_URL must name a dedicated database ending in _test.",
  )

describe.skipIf(!connectionString)("PostgreSQL assistant transactions", () => {
  let pool: Pool
  let db: Db
  const memberIds: string[] = []
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 10 })
    db = drizzle(pool, { schema })
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" })
  }, 30_000)
  afterAll(async () => {
    if (!pool) return
    try {
      if (memberIds.length > 0) {
        await db.delete(drawings).where(inArray(drawings.createdBy, memberIds))
        await db.delete(users).where(inArray(users.id, memberIds))
      }
    } finally {
      await pool.end()
    }
  })

  async function setup() {
    const seed = await seedAssistantTest(db)
    memberIds.push(seed.ownerId, seed.otherId)
    const store = createAssistantStore(db)
    const conversation = await store.getOrCreateConversation(seed.ownerId, {
      drawingId: seed.drawingId,
    })
    const { run } = await store.sendInstruction(seed.ownerId, {
      conversationId: conversation.id,
      requestId: "first",
      body: "Extend the diagram",
    })
    const runInput = { conversationId: conversation.id, runId: run.id }
    const lease = { ...runInput, generation: 1 }
    const report = {
      ...lease,
      requestId: "done",
      controlVersion: 1,
      kind: "completed" as const,
      body: "Finished",
    }
    const claimAndAcknowledge = async () => {
      await store.claimRun(seed.principal, runInput)
      await store.acknowledgeRun(seed.principal, {
        ...lease,
        controlVersion: 1,
        throughSequence: 1,
      })
    }
    return {
      ...seed,
      store,
      conversation,
      run,
      runInput,
      lease,
      report,
      claimAndAcknowledge,
    }
  }

  test("parallel opens and sends serialize to one conversation/task and contiguous messages", async () => {
    const { store, ownerId, drawingId, conversation } = await setup()
    const opens = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.getOrCreateConversation(ownerId, { drawingId }),
      ),
    )
    expect(new Set(opens.map((row) => row.id))).toEqual(
      new Set([conversation.id]),
    )
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.sendInstruction(ownerId, {
          conversationId: conversation.id,
          requestId: `parallel-${index}`,
          body: `Additional ${index}`,
        }),
      ),
    )
    expect(new Set(results.map(({ run }) => run.id)).size).toBe(1)
    expect(
      (
        await store.listMessages(ownerId, { conversationId: conversation.id })
      ).items.map((row) => row.sequence),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(
      (
        await store.getConversation(ownerId, {
          conversationId: conversation.id,
        })
      ).activeRun?.controlVersion,
    ).toBe(9)
  })

  test("simultaneous delivery of the same instruction creates one message and version", async () => {
    const { store, ownerId, runInput } = await setup()
    const input = {
      ...runInput,
      requestId: "duplicate",
      body: "One logical instruction",
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.sendInstruction(ownerId, input)),
    )
    expect(new Set(results.map(({ message }) => message.id)).size).toBe(1)
    expect(
      (await store.getConversation(ownerId, runInput)).activeRun
        ?.controlVersion,
    ).toBe(2)
    expect((await store.listMessages(ownerId, runInput)).items).toHaveLength(2)
  })

  test("two workers racing a claim have one winner and one durable claim event", async () => {
    const { store, principal, runInput, ownerId } = await setup()
    const attempts = await Promise.allSettled([
      store.claimRun(principal, runInput),
      store.claimRun({ ...principal, workerId: "competitor" }, runInput),
    ])
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      attempts.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "run_busy" } })
    expect(
      (await store.listEvents(ownerId, runInput)).items.filter(
        (event) => event.kind === "run_claimed",
      ),
    ).toHaveLength(1)
  })

  test("concurrent result retries produce one assistant message and one receipt", async () => {
    const { store, principal, ownerId, runInput, report, claimAndAcknowledge } =
      await setup()
    await claimAndAcknowledge()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.reportRun(principal, report)),
    )
    expect(new Set(results.map(({ event }) => event.id)).size).toBe(1)
    expect((await store.listMessages(ownerId, runInput)).items).toHaveLength(2)
    expect(
      (await store.getConversation(ownerId, runInput)).activeRun,
    ).toBeNull()
  })

  test("pause racing completion has one serial outcome and cannot commit a result after pause", async () => {
    for (let index = 0; index < 6; index++) {
      const {
        store,
        principal,
        ownerId,
        runInput,
        report,
        claimAndAcknowledge,
      } = await setup()
      await claimAndAcknowledge()
      const pause = () =>
        store.controlRun(ownerId, {
          ...runInput,
          requestId: "pause",
          command: "pause",
          expectedControlVersion: 1,
        })
      const finish = () => store.reportRun(principal, report)
      const attempts = await Promise.allSettled(
        index % 2 ? [pause(), finish()] : [finish(), pause()],
      )
      const state = await store.getConversation(ownerId, runInput)
      const messages = (await store.listMessages(ownerId, runInput)).items
      if (state.latestRun?.status === "completed") {
        expect(state.activeRun).toBeNull()
        expect(messages.map((message) => message.kind)).toEqual([
          "user",
          "assistant",
        ])
        expect(
          attempts.find((result) => result.status === "rejected"),
        ).toMatchObject({ reason: { code: "invalid_transition" } })
      } else {
        expect(state.activeRun).toMatchObject({
          control: "paused",
          controlVersion: 2,
        })
        expect(messages.map((message) => message.kind)).toEqual([
          "user",
          "pause",
        ])
        expect(
          attempts.find((result) => result.status === "rejected"),
        ).toMatchObject({ reason: { code: "stale_control" } })
      }
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1)
    }
  })

  test("a new instruction racing completion either fences it or starts the next task", async () => {
    const { store, principal, ownerId, runInput, report, claimAndAcknowledge } =
      await setup()
    await claimAndAcknowledge()
    const results = await Promise.allSettled([
      store.reportRun(principal, report),
      store.sendInstruction(ownerId, {
        ...runInput,
        requestId: "followup",
        body: "Also fix the labels",
      }),
    ])
    const state = await store.getConversation(ownerId, runInput)
    expect(state.activeRun).not.toBeNull()
    if (results[0].status === "fulfilled") {
      expect(state.activeRun?.id).not.toBe(runInput.runId)
      expect(state.activeRun?.controlVersion).toBe(1)
    } else {
      expect(results[0]).toMatchObject({ reason: { code: "stale_control" } })
      expect(state.activeRun).toMatchObject({
        id: runInput.runId,
        controlVersion: 2,
      })
    }
  })

  test("a transaction failure rolls back task creation, messages and counters together", async () => {
    const seed = await seedAssistantTest(db)
    memberIds.push(seed.ownerId, seed.otherId)
    const store = createAssistantStore(db)
    const conversation = await store.getOrCreateConversation(seed.ownerId, {
      drawingId: seed.drawingId,
    })
    await db
      .update(assistantConversations)
      .set({ nextEventSequence: 2_147_483_647 })
      .where(eq(assistantConversations.id, conversation.id))
    const input = {
      conversationId: conversation.id,
      requestId: "atomic",
      body: "Must be all or nothing",
    }
    await expect(store.sendInstruction(seed.ownerId, input)).rejects.toThrow()
    expect(
      (await store.getConversation(seed.ownerId, input)).activeRun,
    ).toBeNull()
    expect((await store.listMessages(seed.ownerId, input)).items).toEqual([])
    expect((await store.listEvents(seed.ownerId, input)).items).toEqual([])
    await db
      .update(assistantConversations)
      .set({ nextEventSequence: 1 })
      .where(eq(assistantConversations.id, conversation.id))
    expect(
      (await store.sendInstruction(seed.ownerId, input)).message.sequence,
    ).toBe(1)
  })

  test("credential deletion and worker writes are ordered by database locks", async () => {
    const {
      store,
      principal,
      tokenId,
      report,
      runInput,
      ownerId,
      claimAndAcknowledge,
    } = await setup()
    await claimAndAcknowledge()
    const connection = await pool.connect()
    try {
      await connection.query("begin")
      await connection.query(
        "select id from access_tokens where id = $1 for update",
        [tokenId],
      )
      const pending = store.reportRun(principal, report)
      // Install the rejection handler before releasing the credential lock.
      const rejected = expect(pending).rejects.toMatchObject({
        code: "credential_revoked",
      })
      await connection.query("delete from access_tokens where id = $1", [
        tokenId,
      ])
      await connection.query("commit")
      await rejected
    } finally {
      await connection.query("rollback")
      connection.release()
    }
    expect((await store.listMessages(ownerId, runInput)).items).toHaveLength(1)
  })

  test("a fresh application process reads the persisted conversation, receipt and terminal task", async () => {
    const { store, principal, ownerId, runInput, report, claimAndAcknowledge } =
      await setup()
    await claimAndAcknowledge()
    const original = await store.reportRun(principal, report)
    const script = `
      import { drizzle } from 'drizzle-orm/node-postgres';
      import { Pool } from 'pg';
      import { createAssistantStore } from './src/features/assistant/store.ts';
      const pool = new Pool({connectionString: process.env.ASSISTANT_TEST_DATABASE_URL});
      try {
        const store = createAssistantStore(drizzle(pool));
        const input = {conversationId: process.env.REQ001_TEST_CONVERSATION};
        const state = await store.getConversation(process.env.REQ001_TEST_MEMBER, input);
        const messages = await store.listMessages(process.env.REQ001_TEST_MEMBER, input);
        const events = await store.listEvents(process.env.REQ001_TEST_MEMBER, input);
        process.stdout.write(JSON.stringify({status: state.latestRun.status, count: messages.items.length, event: events.items.at(-1).id}));
      } finally {await pool.end();}
    `
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          REQ001_TEST_MEMBER: ownerId,
          REQ001_TEST_CONVERSATION: runInput.conversationId,
        },
        timeout: 10_000,
      },
    )
    expect(JSON.parse(result.stdout)).toEqual({
      status: "completed",
      count: 2,
      event: original.event.id,
    })
  })

  test("SQL constraints independently reject a second unfinished task", async () => {
    const { run } = await setup()
    await expect(
      db.insert(assistantRuns).values({ ...run, id: `${run.id}-duplicate` }),
    ).rejects.toMatchObject({ cause: { code: "23505" } })
    expect(
      await db
        .select()
        .from(assistantEvents)
        .where(
          and(
            eq(assistantEvents.conversationId, run.conversationId),
            eq(assistantEvents.kind, "run_created"),
          ),
        ),
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(assistantMessages)
        .where(eq(assistantMessages.runId, run.id)),
    ).toHaveLength(1)
  })

  const snapshot = (id: string) => ({
    data: JSON.stringify({ elements: [{ id, version: 1, versionNonce: 1 }] }),
    files: [],
  })

  test("REQ-002: racing autosave and promotion has one ordered outcome and never overwrites a promoted scene", async () => {
    for (let index = 0; index < 8; index++) {
      const { ownerId, drawingId } = await setup()
      const promote = () =>
        activateServerWriter(db, ownerId, {
          id: drawingId,
          expectedRevision: 0,
          snapshot: snapshot("handoff"),
        })
      const save = () =>
        writeDrawingScene(db, ownerId, { id: drawingId, ...snapshot("solo") })
      const results = await Promise.all(
        index % 2 ? [promote(), save()] : [save(), promote()],
      )
      const promoted = results.find((result) => result.status === "activated")
      const [row] = await db
        .select()
        .from(drawings)
        .where(eq(drawings.id, drawingId))
      if (promoted) {
        expect(row.serverManagedAt).not.toBeNull()
        expect(JSON.parse(row.data).elements[0].id).toBe("handoff")
        expect(
          await writeDrawingScene(db, ownerId, {
            id: drawingId,
            ...snapshot("late"),
          }),
        ).toMatchObject({ status: "room-required" })
      } else {
        expect(results).toContainEqual({ status: "conflict", sceneRevision: 1 })
        expect(row.serverManagedAt).toBeNull()
        expect(JSON.parse(row.data).elements[0].id).toBe("solo")
      }
    }
  })

  test("REQ-002: concurrent promotion is idempotent and missing images roll back the entire handoff", async () => {
    const { ownerId, drawingId } = await setup()
    const image = {
      id: "image",
      type: "image",
      fileId: "file",
      version: 1,
      versionNonce: 2,
    }
    const input = {
      id: drawingId,
      expectedRevision: 0,
      snapshot: {
        data: JSON.stringify({ elements: [image] }),
        files: [] as { fileId: string; dataUrl: string }[],
      },
    }
    await expect(activateServerWriter(db, ownerId, input)).rejects.toThrow(
      "All scene images",
    )
    expect((await loadRoomScene(db, drawingId)).serverManaged).toBe(false)
    expect(
      await db
        .select()
        .from(drawingFiles)
        .where(eq(drawingFiles.drawingId, drawingId)),
    ).toEqual([])
    input.snapshot.files.push({
      fileId: "file",
      dataUrl: "data:image/png;base64,QUJDRA==",
    })
    const results = await Promise.all(
      Array.from({ length: 6 }, () => activateServerWriter(db, ownerId, input)),
    )
    expect(new Set(results.map((result) => result.sceneRevision))).toEqual(
      new Set([2]),
    )
    expect((await loadRoomScene(db, drawingId)).elements).toEqual([image])
    expect(
      await db
        .select()
        .from(drawingFiles)
        .where(eq(drawingFiles.drawingId, drawingId)),
    ).toHaveLength(1)
  })

  async function sceneSetup() {
    const data = await setup()
    await activateServerWriter(db, data.ownerId, {
      id: data.drawingId,
      expectedRevision: 0,
      snapshot: {
        data: JSON.stringify({
          elements: [
            {
              id: "a",
              type: "rectangle",
              x: 0,
              y: 0,
              width: 100,
              height: 60,
              version: 1,
              versionNonce: 1,
            },
          ],
        }),
        files: [],
      },
    })
    await data.claimAndAcknowledge()
    const registry = createRoomRegistry(
      (id) => loadRoomScene(db, id),
      (id, elements, settings) => saveRoomScene(db, id, elements, settings),
    )
    const scenes = createAssistantSceneStore(db, registry)
    const work = { ...data.lease, controlVersion: 1 }
    const scene = await scenes.readScene(data.principal, work)
    const edit = {
      ...work,
      requestId: "edit",
      summary: "Move A",
      base: scene.base,
      change: [{ id: "a", x: 200 }],
    }
    return { ...data, scenes, edit, registry }
  }

  test("REQ-003: simultaneous commit retries return one persisted operation and scene revision", async () => {
    const { scenes, principal, edit, ownerId, conversation, drawingId } =
      await sceneSetup()
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () => scenes.commitEdit(principal, edit)),
    )
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1)
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1)
    expect(await scenes.listOperations(ownerId, conversation.id)).toHaveLength(
      1,
    )
    expect((await loadRoomScene(db, drawingId)).elements[0].x).toBe(200)
  })

  test("REQ-003: pause and scene commit serialize on the drawing lock; no later edit crosses the pause", async () => {
    for (let index = 0; index < 6; index++) {
      const { scenes, store, principal, edit, ownerId, runInput, drawingId } =
        await sceneSetup()
      const pause = store.controlRun(ownerId, {
        ...runInput,
        command: "pause",
        expectedControlVersion: 1,
        requestId: "pause",
      })
      const result = await Promise.allSettled([
        pause,
        scenes.commitEdit(principal, edit),
      ])
      expect(result[0].status).toBe("fulfilled")
      expect(
        (await store.getConversation(ownerId, runInput)).activeRun?.control,
      ).toBe("paused")
      const saved = result[1].status === "fulfilled"
      expect((await loadRoomScene(db, drawingId)).elements[0].x).toBe(
        saved ? 200 : 0,
      )
      await expect(
        scenes.commitEdit(principal, { ...edit, requestId: "late-edit" }),
      ).rejects.toMatchObject({ code: "stale_control" })
      expect(
        await scenes.listOperations(ownerId, runInput.conversationId),
      ).toHaveLength(saved ? 1 : 0)
    }
  })

  test("REQ-007: concurrent reverts create one inverse and fence further worker commits", async () => {
    const {
      scenes,
      edit,
      registry,
      principal,
      ownerId,
      conversation,
      store,
      runInput,
      drawingId,
    } = await sceneSetup()
    const receipt = await scenes.commitEdit(principal, edit)
    const reverts = createAssistantRevertStore(db, registry)
    const input = {
      conversationId: conversation.id,
      operationId: receipt.id,
      requestId: "undo",
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reverts.revertOperation(ownerId, input)),
    )
    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    expect(results.filter((result) => !result.replayed)).toHaveLength(1)
    expect((await loadRoomScene(db, drawingId)).elements[0].x).toBe(0)
    expect(
      (await store.getConversation(ownerId, runInput)).activeRun?.control,
    ).toBe("paused")
    await expect(
      scenes.commitEdit(principal, { ...edit, requestId: "late" }),
    ).rejects.toMatchObject({ code: "stale_control" })
  })

  test("REQ-008: credential revocation racing scene commit never inverts credential/run locks", async () => {
    for (let index = 0; index < 6; index++) {
      const {
        scenes,
        edit,
        principal,
        ownerId,
        tokenId,
        store,
        runInput,
        drawingId,
      } = await sceneSetup()
      const results = await Promise.allSettled([
        scenes.commitEdit(principal, edit),
        revokeAccessToken(db, ownerId, tokenId),
      ])
      expect(results[1].status).toBe("fulfilled")
      expect(
        (await store.getConversation(ownerId, runInput)).activeRun?.status,
      ).toBe("queued")
      expect((await loadRoomScene(db, drawingId)).elements[0].x).toBe(
        results[0].status === "fulfilled" ? 200 : 0,
      )
      await expect(
        scenes.commitEdit(principal, { ...edit, requestId: "after-revoke" }),
      ).rejects.toMatchObject({ code: "credential_revoked" })
    }
  })

  test("REQ-008: trash and a strict commit have an ordered outcome and cancel the task atomically", async () => {
    for (let index = 0; index < 4; index++) {
      const { scenes, edit, principal, ownerId, store, runInput, drawingId } =
        await sceneSetup()
      const results = await Promise.allSettled([
        scenes.commitEdit(principal, edit),
        trashDrawingUnit(db, ownerId, drawingId),
      ])
      expect(results[1].status).toBe("fulfilled")
      expect(
        (await store.getConversation(ownerId, runInput)).latestRun?.status,
      ).toBe("cancelled")
      expect((await loadRoomScene(db, drawingId)).elements[0].x).toBe(
        results[0].status === "fulfilled" ? 200 : 0,
      )
      expect((await store.getWork(principal, runInput)).run.status).toBe(
        "cancelled",
      )
    }
  })
})
