// @vitest-environment node
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Db } from "@/db"
import {
  assistantConversations,
  assistantOperations,
  assistantRuns,
  assistantWorkers,
  drawings,
  folders,
  oauthClients,
  oauthGrants,
} from "@/db/schema"
import {
  createAccessToken,
  revokeAccessToken,
} from "@/features/access-tokens/tokens"
import { hardDeleteUser } from "@/features/admin/delete-user"
import { createRoomRegistry } from "@/features/collab/room-session"
import { loadRoomScene, saveRoomScene } from "@/features/collab/scene-store"
import { activateServerWriter } from "@/features/drawings/writer-mode"
import { revokeGrant } from "@/features/oauth/grants"
import { restoreDrawingUnit } from "@/features/trash/restore"
import { trashDrawingUnit, trashFolderUnit } from "@/features/trash/trash"
import { createAssistantSceneStore } from "./scene"
import { createAssistantStore } from "./store"
import { createAssistantTestDb, seedAssistantTest } from "./test-support"
import { createAssistantWorkerStore } from "./workers"

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await createAssistantTestDb())
}, 30_000)
afterAll(async () => close?.())
async function setup(team = false) {
  const seed = await seedAssistantTest(db)
  const drawingId = team ? seed.teamId : seed.drawingId
  await activateServerWriter(db, seed.ownerId, {
    id: drawingId,
    expectedRevision: 0,
    snapshot: { data: "{}", files: [] },
  })
  const store = createAssistantStore(db)
  const conversation = await store.getOrCreateConversation(seed.ownerId, {
    drawingId,
  })
  const { run } = await store.sendInstruction(seed.ownerId, {
    conversationId: conversation.id,
    requestId: "start",
    body: "Add an API node",
  })
  const work = {
    conversationId: conversation.id,
    runId: run.id,
    generation: 1,
    controlVersion: 1,
  }
  await store.claimRun(seed.principal, work)
  await store.acknowledgeRun(seed.principal, { ...work, throughSequence: 1 })
  return { ...seed, drawingId, store, conversation, work }
}

test("trashing atomically cancels work; restoring creates a fresh task rather than resuming old work", async () => {
  const data = await setup()
  await trashDrawingUnit(db, data.ownerId, data.drawingId)
  const state = await data.store.getConversation(data.ownerId, data.work)
  expect(state.activeRun).toBeNull()
  expect(state.latestRun).toMatchObject({
    status: "cancelled",
    controlVersion: 2,
    leaseExpiresAt: null,
  })
  expect((await data.store.getWork(data.principal, data.work)).run.status).toBe(
    "cancelled",
  )
  expect(
    (await data.store.listEvents(data.ownerId, data.work)).items.at(-1)?.data
      .reason,
  ).toBe("drawing_trashed")
  await restoreDrawingUnit(db, data.ownerId, data.drawingId)
  const next = await data.store.sendInstruction(data.ownerId, {
    conversationId: data.conversation.id,
    requestId: "restart",
    body: "Start again",
  })
  expect(next.run.id).not.toBe(data.work.runId)
  await expect(
    data.store.reportRun(data.principal, {
      ...data.work,
      requestId: "late",
      kind: "completed",
      body: "Late result",
    }),
  ).rejects.toMatchObject({ code: "invalid_transition" })
})

test("folder trash cancels every member's private task in its Team drawings", async () => {
  const data = await setup(true)
  const folderId = randomUUID()
  await db.insert(folders).values({
    id: folderId,
    name: "Team folder",
    space: "team",
    createdBy: data.ownerId,
  })
  await db
    .update(drawings)
    .set({ folderId })
    .where(eq(drawings.id, data.drawingId))
  const other = await data.store.getOrCreateConversation(data.otherId, {
    drawingId: data.drawingId,
  })
  await data.store.sendInstruction(data.otherId, {
    conversationId: other.id,
    requestId: "other",
    body: "Another private task",
  })
  await trashFolderUnit(db, data.ownerId, folderId)
  expect(
    (await data.store.getConversation(data.ownerId, data.work)).latestRun
      ?.status,
  ).toBe("cancelled")
  expect(
    (
      await data.store.getConversation(data.otherId, {
        conversationId: other.id,
      })
    ).latestRun?.status,
  ).toBe("cancelled")
})

test("a failed cancellation rolls back both trash and task changes", async () => {
  const data = await setup()
  await db
    .update(assistantConversations)
    .set({ nextEventSequence: 2_147_483_647 })
    .where(eq(assistantConversations.id, data.conversation.id))
  await expect(
    trashDrawingUnit(db, data.ownerId, data.drawingId),
  ).rejects.toThrow()
  expect(
    (await db.select().from(drawings).where(eq(drawings.id, data.drawingId)))[0]
      .deletedAt,
  ).toBeNull()
  expect(
    (await data.store.getConversation(data.ownerId, data.work)).activeRun
      ?.status,
  ).toBe("running")
})

test("token revocation releases its lease immediately for a new credential without accepting the old worker", async () => {
  const data = await setup()
  const workers = createAssistantWorkerStore(db)
  await workers.poll(data.principal)
  await revokeAccessToken(db, data.ownerId, data.tokenId)
  expect(await workers.connections(data.ownerId)).toEqual([])
  const replacement = await createAccessToken(db, data.ownerId, "Replacement")
  const principal = {
    ...data.principal,
    credentialId: replacement.id,
    workerId: "replacement",
  }
  expect(await data.store.claimRun(principal, data.work)).toMatchObject({
    status: "running",
    leaseGeneration: 2,
  })
  await expect(
    data.store.renewLease(data.principal, data.work),
  ).rejects.toMatchObject({ code: "credential_revoked" })
  await data.store.acknowledgeRun(principal, {
    ...data.work,
    generation: 2,
    throughSequence: 1,
  })
})

test("disconnecting OAuth releases that stable grant's work", async () => {
  const data = await setup()
  const clientId = randomUUID(),
    grantId = randomUUID()
  await db.insert(oauthClients).values({
    id: clientId,
    name: "Codex",
    redirectUris: ["http://localhost/callback"],
  })
  await db.insert(oauthGrants).values({
    id: grantId,
    clientId,
    userId: data.ownerId,
    redirectUri: "http://localhost/callback",
    codeChallenge: "pkce",
    codeExpiresAt: new Date(),
    accessTokenHash: randomUUID(),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  })
  await db
    .update(assistantRuns)
    .set({ leaseExpiresAt: new Date(0) })
    .where(eq(assistantRuns.id, data.work.runId))
  const principal = {
    ...data.principal,
    credentialKind: "oauth_grant" as const,
    credentialId: grantId,
  }
  await data.store.claimRun(principal, data.work)
  await revokeGrant(db, data.ownerId, grantId)
  const reclaimed = await data.store.claimRun(data.principal, data.work)
  expect(reclaimed.leaseGeneration).toBe(3)
  await expect(
    data.store.renewLease(principal, { ...data.work, generation: 2 }),
  ).rejects.toMatchObject({ code: "credential_revoked" })
})

test("a restarted execution instance cannot reuse an orphan's live lease and fences it after expiration", async () => {
  const data = await setup()
  const replacement = {
    ...data.principal,
    workerId: `${data.principal.workerId}:new-process`,
  }
  await expect(
    data.store.claimRun(replacement, data.work),
  ).rejects.toMatchObject({ code: "run_busy" })
  expect(await createAssistantWorkerStore(db).poll(replacement)).toEqual([])
  await db
    .update(assistantRuns)
    .set({ leaseExpiresAt: new Date(0) })
    .where(eq(assistantRuns.id, data.work.runId))
  expect(await data.store.claimRun(replacement, data.work)).toMatchObject({
    leaseGeneration: 2,
  })
  await expect(
    data.store.reportRun(data.principal, {
      ...data.work,
      requestId: "orphan",
      kind: "completed",
      body: "Old process",
    }),
  ).rejects.toMatchObject({ code: "lease_lost" })
})

test("account deletion cascades private history, operations and workers while retaining the Team scene", async () => {
  const data = await setup(true)
  const registry = createRoomRegistry(
    (id) => loadRoomScene(db, id),
    (id, elements, settings) => saveRoomScene(db, id, elements, settings),
  )
  const scenes = createAssistantSceneStore(db, registry)
  await scenes.commitEdit(data.principal, {
    ...data.work,
    requestId: "edit",
    summary: "API",
    base: {},
    add: [{ type: "rectangle", label: "API" }],
  })
  await createAssistantWorkerStore(db).poll(data.principal)
  await hardDeleteUser(db, data.ownerId)
  expect(
    (await loadRoomScene(db, data.drawingId)).elements.length,
  ).toBeGreaterThan(0)
  expect(
    await db
      .select()
      .from(assistantConversations)
      .where(eq(assistantConversations.id, data.conversation.id)),
  ).toEqual([])
  expect(
    await db
      .select()
      .from(assistantOperations)
      .where(eq(assistantOperations.conversationId, data.conversation.id)),
  ).toEqual([])
  expect(
    await db
      .select()
      .from(assistantWorkers)
      .where(eq(assistantWorkers.userId, data.ownerId)),
  ).toEqual([])
})
