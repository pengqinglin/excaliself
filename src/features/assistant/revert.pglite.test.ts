// @vitest-environment node
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import type { Db } from "@/db"
import {
  assistantConversations,
  assistantOperations,
  drawingFiles,
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
import { ASSISTANT_UNDO_RETENTION_MS } from "./limits"
import { createAssistantRevertStore } from "./revert"
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

async function setup(image = false) {
  const seed = await seedAssistantTest(db)
  await activateServerWriter(db, seed.ownerId, {
    id: seed.drawingId,
    expectedRevision: 0,
    snapshot: {
      data: JSON.stringify({
        elements: [
          shape("a"),
          shape("b"),
          ...(image
            ? [{ ...shape("image"), type: "image", fileId: "image-file" }]
            : []),
        ],
      }),
      files: image
        ? [{ fileId: "image-file", dataUrl: "data:image/png;base64,QUJDRA==" }]
        : [],
    },
  })
  const registry = createRoomRegistry(
    (id) => loadRoomScene(db, id),
    (id, elements, settings) => saveRoomScene(db, id, elements, settings),
  )
  const store = createAssistantStore(db)
  const scenes = createAssistantSceneStore(db, registry)
  const reverts = createAssistantRevertStore(db, registry)
  const conversation = await store.getOrCreateConversation(seed.ownerId, {
    drawingId: seed.drawingId,
  })
  const { run } = await store.sendInstruction(seed.ownerId, {
    conversationId: conversation.id,
    requestId: "start",
    body: "Edit drawing",
  })
  const work = {
    conversationId: conversation.id,
    runId: run.id,
    generation: 1,
    controlVersion: 1,
  }
  await store.claimRun(seed.principal, work)
  await store.acknowledgeRun(seed.principal, { ...work, throughSequence: 1 })
  const snapshot = await scenes.readScene(seed.principal, work)
  const edit = {
    ...work,
    requestId: "edit",
    summary: "Move A",
    base: snapshot.base,
    change: [{ id: "a", x: 200 }],
  }
  const revert = (operationId: string, requestId = "undo") =>
    reverts.revertOperation(seed.ownerId, {
      conversationId: conversation.id,
      operationId,
      requestId,
    })
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
    store,
    registry,
    scenes,
    reverts,
    conversation,
    work,
    snapshot,
    edit,
    revert,
    peer,
    join,
    update,
  }
}

test("add/change/remove reverse as a new durable operation and atomically fence the current task", async () => {
  const data = await setup()
  const receipt = await data.scenes.commitEdit(data.principal, {
    ...data.edit,
    add: [{ type: "rectangle", label: "New" }],
    remove: ["b"],
  })
  const reversed = await data.revert(receipt.id)
  expect(reversed).toMatchObject({
    status: "saved",
    undoOf: receipt.id,
    sceneRevision: 4,
    replayed: false,
  })
  const scene = await loadRoomScene(db, data.drawingId)
  expect(scene.elements.find((el) => el.id === "a")).toMatchObject({
    x: 0,
    version: 3,
  })
  expect(scene.elements.find((el) => el.id === "b")).toMatchObject({
    version: 3,
  })
  expect(scene.elements.find((el) => el.id === "b")?.isDeleted).not.toBe(true)
  expect(
    scene.elements
      .filter((el) => !["a", "b"].includes(el.id))
      .every((el) => el.isDeleted),
  ).toBe(true)
  expect(
    (await data.store.getConversation(data.ownerId, data.work)).activeRun,
  ).toMatchObject({ control: "paused", controlVersion: 2 })
  await expect(
    data.scenes.commitEdit(data.principal, { ...data.edit, requestId: "late" }),
  ).rejects.toMatchObject({ code: "stale_control" })
  expect(await data.revert(receipt.id, "another-click")).toMatchObject({
    id: reversed.id,
    replayed: true,
  })
  expect(
    await data.scenes.listOperations(data.ownerId, data.conversation.id),
  ).toHaveLength(2)
})

test("revert preserves unrelated human edits and refuses a changed target without pausing", async () => {
  for (const target of ["a", "b"]) {
    const data = await setup()
    const receipt = await data.scenes.commitEdit(data.principal, data.edit)
    await data.join()
    try {
      await data.update(target, 999)
      if (target === "a") {
        await expect(data.revert(receipt.id)).rejects.toMatchObject({
          code: "scene_conflict",
        })
        expect(
          (await data.store.getConversation(data.ownerId, data.work)).activeRun
            ?.control,
        ).toBe("running")
      } else {
        await data.revert(receipt.id)
        expect(
          (await loadRoomScene(db, data.drawingId)).elements.find(
            (el) => el.id === "a",
          )?.x,
        ).toBe(0)
      }
      expect(
        data.registry.rooms
          .get(data.drawingId)
          ?.elements.find((el) => el.id === target)?.x,
      ).toBe(999)
    } finally {
      await leaveRoom(data.registry, data.drawingId, data.peer)
    }
  }
})

test("settings restore only affected fields and reject a later change of that field", async () => {
  for (const field of ["gridSize", "viewBackgroundColor"] as const) {
    const data = await setup()
    const receipt = await data.scenes.commitEdit(data.principal, {
      ...data.edit,
      change: [],
      settings: {
        base: data.snapshot.settings,
        patch: { viewBackgroundColor: "#fafafa" },
      },
    })
    await data.join()
    try {
      const settings = {
        ...data.registry.rooms.get(data.drawingId)?.settings,
        [field]: field === "gridSize" ? 40 : "#111111",
      }
      await receiveFromPeer(
        data.registry,
        data.drawingId,
        data.peer,
        JSON.stringify({
          type: "SCENE_STATE",
          payload: { appState: settings, baseRevision: 0, requestId: 1 },
        }),
      )
      if (field === "viewBackgroundColor")
        await expect(data.revert(receipt.id)).rejects.toMatchObject({
          code: "scene_conflict",
        })
      else {
        await data.revert(receipt.id)
        expect(
          (await loadRoomScene(db, data.drawingId)).settings,
        ).toMatchObject({ viewBackgroundColor: "#ffffff", gridSize: 40 })
      }
    } finally {
      await leaveRoom(data.registry, data.drawingId, data.peer)
    }
  }
})

test("deleted image bytes survive ordinary Room cleanup throughout the revert window", async () => {
  const data = await setup(true)
  const receipt = await data.scenes.commitEdit(data.principal, {
    ...data.edit,
    change: [],
    remove: ["image"],
  })
  const old = new Date(Date.now() - 3 * 24 * 60 * 60_000)
  await db
    .update(drawingFiles)
    .set({ createdAt: old })
    .where(eq(drawingFiles.drawingId, data.drawingId))
  const stored = await loadRoomScene(db, data.drawingId)
  const elements = stored.elements.map((element) =>
    element.id === "image" ? { ...element, updated: old.getTime() } : element,
  )
  await saveRoomScene(db, data.drawingId, elements)
  expect(
    await db
      .select()
      .from(drawingFiles)
      .where(eq(drawingFiles.drawingId, data.drawingId)),
  ).toHaveLength(1)
  await data.revert(receipt.id)
  expect(
    (await loadRoomScene(db, data.drawingId)).elements.find(
      (el) => el.id === "image",
    )?.isDeleted,
  ).not.toBe(true)
  await db
    .update(assistantOperations)
    .set({ createdAt: new Date(Date.now() - ASSISTANT_UNDO_RETENTION_MS - 1) })
    .where(eq(assistantOperations.id, receipt.id))
  await saveRoomScene(db, data.drawingId, elements)
  expect(
    await db
      .select()
      .from(drawingFiles)
      .where(eq(drawingFiles.drawingId, data.drawingId)),
  ).toHaveLength(0)
})

test("missing image bytes, expired operations and other members cannot revert", async () => {
  const data = await setup(true)
  const receipt = await data.scenes.commitEdit(data.principal, {
    ...data.edit,
    change: [],
    remove: ["image"],
  })
  await expect(
    data.reverts.revertOperation(data.otherId, {
      conversationId: data.conversation.id,
      operationId: receipt.id,
      requestId: "intrude",
    }),
  ).rejects.toMatchObject({ code: "not_found" })
  const expired = createAssistantRevertStore(
    db,
    data.registry,
    () => new Date(Date.now() + ASSISTANT_UNDO_RETENTION_MS + 1),
  )
  await expect(
    expired.revertOperation(data.ownerId, {
      conversationId: data.conversation.id,
      operationId: receipt.id,
      requestId: "expired",
    }),
  ).rejects.toMatchObject({ code: "scene_conflict" })
  await db
    .delete(drawingFiles)
    .where(eq(drawingFiles.drawingId, data.drawingId))
  await expect(data.revert(receipt.id)).rejects.toMatchObject({
    code: "scene_conflict",
  })
  expect(
    (await data.store.getConversation(data.ownerId, data.work)).activeRun
      ?.control,
  ).toBe("running")
})

test("a failed inverse transaction changes neither scene, original receipt, task control nor Room", async () => {
  const data = await setup()
  const receipt = await data.scenes.commitEdit(data.principal, data.edit)
  await data.join()
  try {
    vi.mocked(data.peer.send).mockClear()
    await db
      .update(assistantConversations)
      .set({ nextEventSequence: 2_147_483_647 })
      .where(eq(assistantConversations.id, data.conversation.id))
    await expect(data.revert(receipt.id)).rejects.toThrow()
    expect(
      data.registry.rooms
        .get(data.drawingId)
        ?.elements.find((el) => el.id === "a")?.x,
    ).toBe(200)
    expect(
      (await data.scenes.listOperations(data.ownerId, data.conversation.id))[0]
        .revertedAt,
    ).toBeNull()
    expect(
      (await data.store.getConversation(data.ownerId, data.work)).activeRun
        ?.control,
    ).toBe("running")
    expect(data.peer.send).not.toHaveBeenCalled()
    await db
      .update(assistantConversations)
      .set({ nextEventSequence: 10 })
      .where(eq(assistantConversations.id, data.conversation.id))
    await data.revert(receipt.id)
    expect(data.peer.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SCENE_UPDATE" }),
    )
  } finally {
    await leaveRoom(data.registry, data.drawingId, data.peer)
  }
})
