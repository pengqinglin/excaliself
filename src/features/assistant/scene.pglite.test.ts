// @vitest-environment node
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import type { Db } from "@/db"
import {
  accessTokens,
  assistantConversations,
  assistantOperations,
  drawings,
} from "@/db/schema"
import {
  createRoomRegistry,
  joinRoom,
  leaveRoom,
  type RoomPeer,
  receiveFromPeer,
} from "@/features/collab/room-session"
import { loadRoomScene, saveRoomScene } from "@/features/collab/scene-store"
import { activateServerWriter } from "@/features/drawings/writer-mode"
import { createAssistantSceneStore } from "./scene"
import { createAssistantStore } from "./store"
import { createAssistantTestDb, seedAssistantTest } from "./test-support"

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await createAssistantTestDb())
}, 30_000)
afterAll(async () => close?.())
const shape = (id: string) => ({
  id,
  version: 1,
  versionNonce: 1,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
})

async function setup() {
  const seed = await seedAssistantTest(db)
  await activateServerWriter(db, seed.ownerId, {
    id: seed.drawingId,
    expectedRevision: 0,
    snapshot: {
      data: JSON.stringify({ elements: [shape("a"), shape("b")] }),
      files: [],
    },
  })
  const registry = createRoomRegistry(
    (id) => loadRoomScene(db, id),
    (id, elements, settings) => saveRoomScene(db, id, elements, settings),
  )
  const store = createAssistantStore(db)
  const scenes = createAssistantSceneStore(db, registry)
  const conversation = await store.getOrCreateConversation(seed.ownerId, {
    drawingId: seed.drawingId,
  })
  const { run } = await store.sendInstruction(seed.ownerId, {
    conversationId: conversation.id,
    requestId: "start",
    body: "Move A",
  })
  const input = {
    conversationId: conversation.id,
    runId: run.id,
    generation: 1,
    controlVersion: 1,
  }
  await store.claimRun(seed.principal, input)
  await store.acknowledgeRun(seed.principal, { ...input, throughSequence: 1 })
  const snapshot = await scenes.readScene(seed.principal, input)
  const edit = {
    ...input,
    requestId: "edit",
    summary: "Move A",
    base: snapshot.base,
    change: [{ id: "a", x: 200 }],
  }
  const peer: RoomPeer = {
    id: "owner",
    bufferedAmount: 0,
    send: vi.fn(),
    publish: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  }
  const join = () =>
    joinRoom(registry, seed.drawingId, peer, {
      userId: seed.ownerId,
      sessionId: "session",
      displayName: "Owner",
      image: null,
    })
  const update = (id: string, x: number) =>
    receiveFromPeer(
      registry,
      seed.drawingId,
      peer,
      JSON.stringify({
        type: "SCENE_UPDATE",
        payload: {
          elements: [
            {
              ...shape(id),
              x,
              version:
                (registry.rooms
                  .get(seed.drawingId)
                  ?.elements.find((el) => el.id === id)?.version ?? 1) + 1,
            },
          ],
        },
      }),
    )
  return {
    ...seed,
    registry,
    store,
    scenes,
    input,
    snapshot,
    edit,
    peer,
    join,
    update,
  }
}

test("a commit with no open browser is durable, replayable, and reloads into a fresh Room", async () => {
  const {
    ownerId,
    principal,
    drawingId,
    scenes,
    registry,
    edit,
    store,
    input,
  } = await setup()
  const receipt = await scenes.commitEdit(principal, edit)
  expect(receipt).toMatchObject({
    status: "saved",
    replayed: false,
    sceneRevision: 3,
  })
  expect(registry.rooms.size).toBe(0)
  expect(
    (await loadRoomScene(db, drawingId)).elements.find((el) => el.id === "a")
      ?.x,
  ).toBe(200)
  const replay = await scenes.commitEdit(principal, edit)
  expect(replay).toMatchObject({
    id: receipt.id,
    replayed: true,
    sceneRevision: 3,
  })
  expect(
    await scenes.listOperations(ownerId, input.conversationId),
  ).toHaveLength(1)
  expect(
    (await store.listEvents(ownerId, input)).items.filter(
      (event) => event.kind === "scene_committed",
    ),
  ).toHaveLength(1)
})

test("unrelated live edits survive; a changed target rejects the whole operation", async () => {
  const { principal, drawingId, scenes, registry, edit, peer, join, update } =
    await setup()
  await join()
  try {
    await update("b", 500)
    await scenes.commitEdit(principal, edit)
    expect(
      Object.fromEntries(
        (await loadRoomScene(db, drawingId)).elements.map(({ id, x }) => [
          id,
          x,
        ]),
      ),
    ).toEqual({ a: 200, b: 500 })
    await update("a", 999)
    await expect(
      scenes.commitEdit(principal, { ...edit, requestId: "conflict" }),
    ).rejects.toMatchObject({ code: "scene_conflict" })
    expect(
      registry.rooms.get(drawingId)?.elements.find((el) => el.id === "a")?.x,
    ).toBe(999)
  } finally {
    await leaveRoom(registry, drawingId, peer)
  }
})

test("new shapes and labels have stable ordered indices before their receipt is persisted", async () => {
  const { principal, drawingId, scenes, registry, peer, join, input } =
    await setup()
  await join()
  try {
    await receiveFromPeer(
      registry,
      drawingId,
      peer,
      JSON.stringify({
        type: "SCENE_UPDATE",
        payload: {
          elements: [
            { ...shape("a"), version: 2, index: "a0" },
            { ...shape("b"), version: 2, index: "a1" },
          ],
        },
      }),
    )
    const snapshot = await scenes.readScene(principal, input)
    const receipt = await scenes.commitEdit(principal, {
      ...input,
      requestId: "add-indexed",
      summary: "Add an API",
      base: snapshot.base,
      add: [{ type: "rectangle", label: "API" }],
    })
    const [operation] = await db
      .select()
      .from(assistantOperations)
      .where(eq(assistantOperations.id, receipt.id))
    expect(operation.after).toHaveLength(2)
    const indices = operation.after.map((element) => element.index)
    expect(indices).toEqual(["a2", "a3"])
    const stored = await loadRoomScene(db, drawingId)
    expect(stored.elements.map((element) => element.index)).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
    ])
    for (const element of operation.after)
      expect(stored.elements.find(({ id }) => id === element.id)).toEqual(
        element,
      )
  } finally {
    await leaveRoom(registry, drawingId, peer)
  }
})

test("a new instruction and a pause fence an already planned edit", async () => {
  for (const action of ["pause", "message"] as const) {
    const { ownerId, principal, scenes, edit, input, store, drawingId } =
      await setup()
    if (action === "pause")
      await store.controlRun(ownerId, {
        ...input,
        command: "pause",
        expectedControlVersion: 1,
        requestId: "pause",
      })
    else
      await store.sendInstruction(ownerId, {
        ...input,
        requestId: "new",
        body: "Use a different layout",
      })
    await expect(scenes.commitEdit(principal, edit)).rejects.toMatchObject({
      code: "stale_control",
    })
    expect((await loadRoomScene(db, drawingId)).elements[0].x).toBe(0)
    expect(await scenes.listOperations(ownerId, input.conversationId)).toEqual(
      [],
    )
  }
})

test("revoked credentials, lost leases, another member and reused IDs cannot write", async () => {
  const { principal, otherId, scenes, edit, tokenId, registry } = await setup()
  await expect(
    scenes.commitEdit({ ...principal, userId: otherId }, edit),
  ).rejects.toMatchObject({ code: "not_found" })
  await expect(
    scenes.commitEdit(principal, { ...edit, generation: 2 }),
  ).rejects.toMatchObject({ code: "lease_lost" })
  await scenes.commitEdit(principal, edit)
  await expect(
    scenes.commitEdit(principal, { ...edit, summary: "Different" }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" })
  await db.delete(accessTokens).where(eq(accessTokens.id, tokenId))
  await expect(scenes.commitEdit(principal, edit)).rejects.toMatchObject({
    code: "credential_revoked",
  })
  expect(registry.rooms.size).toBe(0)
})

test("database failure rolls back scene, receipt and event without changing or broadcasting the Room", async () => {
  const { principal, scenes, edit, input, drawingId, registry, peer, join } =
    await setup()
  await join()
  try {
    vi.mocked(peer.send).mockClear()
    await db
      .update(assistantConversations)
      .set({ nextEventSequence: 2_147_483_647 })
      .where(eq(assistantConversations.id, input.conversationId))
    await expect(scenes.commitEdit(principal, edit)).rejects.toThrow()
    expect(registry.rooms.get(drawingId)?.elements[0].x).toBe(0)
    expect((await loadRoomScene(db, drawingId)).elements[0].x).toBe(0)
    expect(
      await db
        .select()
        .from(assistantOperations)
        .where(eq(assistantOperations.conversationId, input.conversationId)),
    ).toEqual([])
    expect(peer.send).not.toHaveBeenCalled()
    await db
      .update(assistantConversations)
      .set({ nextEventSequence: 10 })
      .where(eq(assistantConversations.id, input.conversationId))
    await expect(scenes.commitEdit(principal, edit)).resolves.toMatchObject({
      status: "saved",
    })
    expect(peer.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SCENE_UPDATE" }),
    )
  } finally {
    await leaveRoom(registry, drawingId, peer)
  }
})

test("settings compare only edited fields and persist together with elements", async () => {
  const { principal, scenes, edit, snapshot, drawingId, registry, peer, join } =
    await setup()
  await join()
  try {
    await receiveFromPeer(
      registry,
      drawingId,
      peer,
      JSON.stringify({
        type: "SCENE_STATE",
        payload: {
          appState: { ...snapshot.settings, gridSize: 40 },
          baseRevision: 0,
          requestId: 1,
        },
      }),
    )
    await scenes.commitEdit(principal, {
      ...edit,
      settings: {
        base: snapshot.settings,
        patch: { viewBackgroundColor: "#fafafa" },
      },
    })
    expect((await loadRoomScene(db, drawingId)).settings).toMatchObject({
      viewBackgroundColor: "#fafafa",
      gridSize: 40,
    })
    await expect(
      scenes.commitEdit(principal, {
        ...edit,
        requestId: "setting-conflict",
        change: [],
        settings: { base: snapshot.settings, patch: { gridSize: 60 } },
      }),
    ).rejects.toMatchObject({ code: "scene_conflict" })
  } finally {
    await leaveRoom(registry, drawingId, peer)
  }
})

test("expired work and a trashed drawing cannot produce a new receipt", async () => {
  const { principal, edit, registry, drawingId, scenes } = await setup()
  const expired = createAssistantSceneStore(
    db,
    registry,
    () => new Date(Date.now() + 61_000),
  )
  await expect(expired.commitEdit(principal, edit)).rejects.toMatchObject({
    code: "lease_lost",
  })
  await db
    .update(drawings)
    .set({ deletedAt: new Date() })
    .where(eq(drawings.id, drawingId))
  await expect(scenes.commitEdit(principal, edit)).rejects.toMatchObject({
    code: "not_found",
  })
})
