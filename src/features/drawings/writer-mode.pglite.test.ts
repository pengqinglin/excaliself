// @vitest-environment node
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Db } from "@/db"
import { drawingFiles, drawings, shares } from "@/db/schema"
import {
  createAssistantTestDb,
  seedAssistantTest,
} from "@/features/assistant/test-support"
import { loadRoomScene, saveRoomScene } from "@/features/collab/scene-store"
import { writeDrawingScene } from "./scene-write"
import { activateServerWriter } from "./writer-mode"

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await createAssistantTestDb())
}, 30_000)
afterAll(async () => close?.())
const snapshot = (id = "shape") => ({
  data: JSON.stringify({
    elements: [{ id, version: 1, versionNonce: 2 }],
    appState: { viewBackgroundColor: "#fafafa", gridSize: 20 },
  }),
  files: [],
})

test("the final private snapshot and writer flag persist atomically; repeated activation never replays it", async () => {
  const { ownerId, drawingId } = await seedAssistantTest(db)
  const result = await activateServerWriter(db, ownerId, {
    id: drawingId,
    expectedRevision: 0,
    snapshot: snapshot(),
  })
  expect(result).toMatchObject({ status: "activated", sceneRevision: 2 })
  expect(
    (await loadRoomScene(db, drawingId)).elements.map((el) => el.id),
  ).toEqual(["shape"])
  await saveRoomScene(db, drawingId, [
    { id: "newer", version: 2, versionNonce: 4 },
  ])
  expect(
    await activateServerWriter(db, ownerId, {
      id: drawingId,
      expectedRevision: 0,
      snapshot: snapshot("obsolete"),
    }),
  ).toMatchObject({ status: "activated", sceneRevision: 3 })
  expect(
    (await loadRoomScene(db, drawingId)).elements.map((el) => el.id),
  ).toEqual(["newer"])
  expect(
    await writeDrawingScene(db, ownerId, {
      id: drawingId,
      ...snapshot("stale"),
    }),
  ).toMatchObject({ status: "room-required" })
  expect(
    (await loadRoomScene(db, drawingId)).elements.map((el) => el.id),
  ).toEqual(["newer"])
})

test("a concurrent solo revision rejects activation without touching the scene or mode", async () => {
  const { ownerId, drawingId } = await seedAssistantTest(db)
  expect(
    await writeDrawingScene(db, ownerId, {
      id: drawingId,
      ...snapshot("other-tab"),
    }),
  ).toMatchObject({ status: "saved", sceneRevision: 1 })
  expect(
    await activateServerWriter(db, ownerId, {
      id: drawingId,
      expectedRevision: 0,
      snapshot: snapshot(),
    }),
  ).toEqual({ status: "conflict", sceneRevision: 1 })
  const [row] = await db
    .select()
    .from(drawings)
    .where(eq(drawings.id, drawingId))
  expect(row.serverManagedAt).toBeNull()
  expect(JSON.parse(row.data).elements[0].id).toBe("other-tab")
})

test("team and shared drawings promote without overwriting the Room's stored scene", async () => {
  const { ownerId, drawingId, teamId } = await seedAssistantTest(db)
  await writeDrawingScene(db, ownerId, { id: drawingId, ...snapshot("stored") })
  await db
    .insert(shares)
    .values({ id: drawingId, token: drawingId, drawingId, audience: "anyone" })
  for (const id of [drawingId, teamId])
    expect(
      await activateServerWriter(db, ownerId, {
        id,
        expectedRevision: 999,
        snapshot: snapshot("obsolete"),
      }),
    ).toMatchObject({ status: "activated" })
  expect((await loadRoomScene(db, drawingId)).elements[0].id).toBe("stored")
})

test("all referenced images must be stored, otherwise activation rolls back", async () => {
  const { ownerId, drawingId } = await seedAssistantTest(db)
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
  const [row] = await db
    .select()
    .from(drawings)
    .where(eq(drawings.id, drawingId))
  expect(row).toMatchObject({
    data: "{}",
    serverManagedAt: null,
    sceneRevision: 0,
  })
  input.snapshot.files.push({
    fileId: "file",
    dataUrl: "data:image/png;base64,QUJDRA==",
  })
  await activateServerWriter(db, ownerId, input)
  expect(
    await db
      .select()
      .from(drawingFiles)
      .where(eq(drawingFiles.drawingId, drawingId)),
  ).toHaveLength(1)
})

test("inaccessible, trashed and invalid final scenes cannot be promoted", async () => {
  const { ownerId, otherId, drawingId } = await seedAssistantTest(db)
  const input = { id: drawingId, expectedRevision: 0, snapshot: snapshot() }
  await expect(activateServerWriter(db, otherId, input)).rejects.toThrow(
    "Drawing not found",
  )
  for (const data of [
    "garbage",
    "null",
    '{"elements":[{"id":"bad","version":-1,"versionNonce":1}]}',
  ])
    await expect(
      activateServerWriter(db, ownerId, {
        ...input,
        snapshot: { data, files: [] },
      }),
    ).rejects.toThrow()
  await db
    .update(drawings)
    .set({ deletedAt: new Date() })
    .where(eq(drawings.id, drawingId))
  await expect(activateServerWriter(db, ownerId, input)).rejects.toThrow(
    "Drawing not found",
  )
})
