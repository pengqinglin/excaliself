// @vitest-environment node
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Db } from "@/db"
import { accessTokens, drawings, oauthClients, oauthGrants } from "@/db/schema"
import { LEASE_DURATION_MS } from "./state"
import { createAssistantStore } from "./store"
import { createAssistantTestDb, seedAssistantTest } from "./test-support"

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await createAssistantTestDb())
}, 30_000)
afterAll(async () => close?.())

async function setup() {
  const seed = await seedAssistantTest(db)
  let timestamp = new Date("2026-11-25T12:00:00Z")
  const store = createAssistantStore(db, () => timestamp)
  const conversation = await store.getOrCreateConversation(seed.ownerId, {
    drawingId: seed.drawingId,
  })
  const { run } = await store.sendInstruction(seed.ownerId, {
    conversationId: conversation.id,
    requestId: "first",
    body: "Extend the existing diagram",
  })
  const runInput = { conversationId: conversation.id, runId: run.id }
  const lease = { ...runInput, generation: 1 }
  const report = {
    ...lease,
    requestId: "result",
    controlVersion: 1,
    kind: "completed" as const,
    body: "Completed the requested work.",
  }
  const acknowledge = () =>
    store.acknowledgeRun(seed.principal, {
      ...lease,
      controlVersion: 1,
      throughSequence: 1,
    })
  const claim = () => store.claimRun(seed.principal, runInput)
  const control = (
    command: "pause" | "resume" | "cancel",
    expectedControlVersion: number,
    requestId: string = command,
  ) =>
    store.controlRun(seed.ownerId, {
      ...runInput,
      requestId,
      command,
      expectedControlVersion,
    })
  return {
    ...seed,
    store,
    run,
    runInput,
    lease,
    report,
    acknowledge,
    claim,
    control,
    advance: (ms: number) => {
      timestamp = new Date(timestamp.getTime() + ms)
    },
  }
}

test("claim retries keep one lease and another worker cannot take a live lease", async () => {
  const { store, principal, runInput, claim } = await setup()
  const first = await claim()
  expect(await claim()).toEqual(first)
  expect(first).toMatchObject({
    status: "running",
    leaseGeneration: 1,
    acknowledgedControlVersion: 0,
    receivedThroughSequence: 0,
  })
  await expect(
    store.claimRun({ ...principal, workerId: "second-worker" }, runInput),
  ).rejects.toMatchObject({ code: "run_busy" })
})

test("a heartbeat is not an input acknowledgement", async () => {
  const { store, principal, lease, report, claim, advance, acknowledge } =
    await setup()
  const claimed = await claim()
  advance(20_000)
  const renewed = await store.renewLease(principal, lease)
  expect(renewed.leaseExpiresAt).toEqual(
    new Date(Number(claimed.leaseExpiresAt) + 20_000),
  )
  expect(renewed.receivedThroughSequence).toBe(0)
  await expect(store.reportRun(principal, report)).rejects.toMatchObject({
    code: "input_unacknowledged",
  })
  const ack = await acknowledge()
  expect(ack).toMatchObject({
    receivedThroughSequence: 1,
    acknowledgedControlVersion: 1,
  })
  expect(await acknowledge()).toEqual(ack)
})

test("expired leases cannot renew or report, and takeover requires a fresh acknowledgement", async () => {
  const {
    store,
    principal,
    runInput,
    lease,
    report,
    claim,
    acknowledge,
    advance,
  } = await setup()
  await claim()
  await acknowledge()
  advance(LEASE_DURATION_MS)
  await expect(store.renewLease(principal, lease)).rejects.toMatchObject({
    code: "lease_lost",
  })
  await expect(store.reportRun(principal, report)).rejects.toMatchObject({
    code: "lease_lost",
  })
  const replacement = { ...principal, workerId: "replacement" }
  expect(await store.claimRun(replacement, runInput)).toMatchObject({
    leaseGeneration: 2,
    acknowledgedControlVersion: 0,
  })
  await expect(store.reportRun(principal, report)).rejects.toMatchObject({
    code: "lease_lost",
  })
  await expect(
    store.reportRun(replacement, { ...report, generation: 2 }),
  ).rejects.toMatchObject({ code: "input_unacknowledged" })
  await store.acknowledgeRun(replacement, {
    ...lease,
    generation: 2,
    controlVersion: 1,
    throughSequence: 1,
  })
  expect(
    (await store.reportRun(replacement, { ...report, generation: 2 })).event
      .data.status,
  ).toBe("completed")
})

test("pause is persisted before worker acknowledgement and blocks new results", async () => {
  const {
    store,
    principal,
    lease,
    report,
    claim,
    acknowledge,
    control,
    runInput,
  } = await setup()
  await claim()
  await acknowledge()
  const paused = await control("pause", 1)
  expect(paused.run).toMatchObject({
    control: "paused",
    controlVersion: 2,
    workerState: "working",
    acknowledgedControlVersion: 1,
  })
  await expect(store.reportRun(principal, report)).rejects.toMatchObject({
    code: "stale_control",
  })
  await store.renewLease(principal, lease)
  const ack = await store.acknowledgeRun(principal, {
    ...lease,
    controlVersion: 2,
    throughSequence: 2,
  })
  expect(ack.workerState).toBe("paused")
  await expect(
    store.reportRun(principal, { ...report, controlVersion: 2 }),
  ).rejects.toMatchObject({ code: "paused" })
  expect((await store.getWork(principal, runInput)).run.control).toBe("paused")
})

test("resume fences pre-pause work and rechecks the current message position", async () => {
  const { store, principal, lease, report, claim, acknowledge, control } =
    await setup()
  await claim()
  await acknowledge()
  await control("pause", 1)
  await control("resume", 2)
  await expect(store.reportRun(principal, report)).rejects.toMatchObject({
    code: "stale_control",
  })
  await expect(
    store.acknowledgeRun(principal, {
      ...lease,
      controlVersion: 3,
      throughSequence: 1,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" })
  await store.acknowledgeRun(principal, {
    ...lease,
    controlVersion: 3,
    throughSequence: 3,
  })
  expect(
    (await store.reportRun(principal, { ...report, controlVersion: 3 })).event
      .data.status,
  ).toBe("completed")
})

test("member controls are idempotent, reject stale versions and retain one task", async () => {
  const { store, ownerId, runInput, control } = await setup()
  const paused = await control("pause", 1)
  expect((await control("pause", 1)).message).toEqual(paused.message)
  expect((await control("pause", 2, "pause-again")).run.controlVersion).toBe(2)
  await expect(control("resume", 1)).rejects.toMatchObject({
    code: "stale_control",
  })
  await expect(control("resume", 2, "pause")).rejects.toMatchObject({
    code: "idempotency_conflict",
  })
  expect((await store.getConversation(ownerId, runInput)).activeRun?.id).toBe(
    runInput.runId,
  )
})

test("instructions queued while paused stay paused and invalidate old input acknowledgements", async () => {
  const {
    store,
    ownerId,
    principal,
    lease,
    runInput,
    report,
    claim,
    acknowledge,
    control,
  } = await setup()
  await claim()
  await acknowledge()
  await control("pause", 1)
  const next = await store.sendInstruction(ownerId, {
    ...runInput,
    requestId: "additional",
    body: "Fix the connector labels too",
  })
  expect(next.run).toMatchObject({
    id: runInput.runId,
    control: "paused",
    controlVersion: 3,
    lastInputSequence: 3,
  })
  await expect(
    store.acknowledgeRun(principal, {
      ...lease,
      controlVersion: 2,
      throughSequence: 2,
    }),
  ).rejects.toMatchObject({ code: "stale_control" })
  await control("resume", 3)
  await store.acknowledgeRun(principal, {
    ...lease,
    controlVersion: 4,
    throughSequence: 4,
  })
  expect(
    (await store.reportRun(principal, { ...report, controlVersion: 4 })).event
      .data.status,
  ).toBe("completed")
})

test("progress, waiting for input, member reply and completion remain distinct", async () => {
  const {
    store,
    ownerId,
    principal,
    lease,
    runInput,
    report,
    claim,
    acknowledge,
  } = await setup()
  await claim()
  await acknowledge()
  await store.reportRun(principal, {
    ...report,
    requestId: "progress",
    kind: "progress",
    body: "Reading the existing labels.",
  })
  await store.reportRun(principal, {
    ...report,
    requestId: "question",
    kind: "awaiting_input",
    body: "Which branch should I extend?",
  })
  expect((await store.getWork(principal, runInput)).run).toMatchObject({
    status: "awaiting_input",
    workerState: "awaiting_input",
  })
  await expect(store.reportRun(principal, report)).rejects.toMatchObject({
    code: "invalid_transition",
  })
  const next = await store.sendInstruction(ownerId, {
    ...runInput,
    requestId: "answer",
    body: "The right branch",
  })
  expect(next.run).toMatchObject({
    status: "running",
    controlVersion: 2,
    lastInputSequence: 4,
  })
  await store.acknowledgeRun(principal, {
    ...lease,
    controlVersion: 2,
    throughSequence: 4,
  })
  await store.reportRun(principal, { ...report, controlVersion: 2 })
  expect(
    (await store.listMessages(ownerId, runInput)).items.map(
      (message) => message.kind,
    ),
  ).toEqual(["user", "assistant", "assistant", "user", "assistant"])
})

test("completion and failure receipts survive retries without another message or task", async () => {
  for (const kind of ["completed", "failed"] as const) {
    const { store, ownerId, principal, runInput, report, claim, acknowledge } =
      await setup()
    await claim()
    await acknowledge()
    const result = await store.reportRun(principal, { ...report, kind })
    expect(
      await createAssistantStore(db).reportRun(principal, { ...report, kind }),
    ).toEqual(result)
    await expect(
      store.reportRun(principal, { ...report, kind, body: "Changed" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" })
    expect((await store.listMessages(ownerId, runInput)).items).toHaveLength(2)
    const next = await store.sendInstruction(ownerId, {
      ...runInput,
      requestId: "next",
      body: "Another request",
    })
    expect(next.run.id).not.toBe(runInput.runId)
    const retriedFirst = await store.sendInstruction(ownerId, {
      ...runInput,
      requestId: "first",
      body: "Extend the existing diagram",
    })
    expect(retriedFirst.run.id).toBe(runInput.runId)
    expect((await store.getConversation(ownerId, runInput)).activeRun?.id).toBe(
      next.run.id,
    )
  }
})

test("cancellation immediately ends work and cannot be resumed", async () => {
  const {
    store,
    principal,
    runInput,
    lease,
    report,
    claim,
    acknowledge,
    control,
  } = await setup()
  await claim()
  await acknowledge()
  const cancelled = await control("cancel", 1)
  expect(cancelled.run).toMatchObject({
    status: "cancelled",
    leaseExpiresAt: null,
  })
  expect((await store.getWork(principal, runInput)).run.status).toBe(
    "cancelled",
  )
  await expect(store.reportRun(principal, report)).rejects.toMatchObject({
    code: "invalid_transition",
  })
  await expect(store.renewLease(principal, lease)).rejects.toMatchObject({
    code: "invalid_transition",
  })
  await expect(control("resume", 2)).rejects.toMatchObject({
    code: "invalid_transition",
  })
  expect((await control("cancel", 1)).message.id).toBe(cancelled.message.id)
})

test("received positions cannot advance beyond stored messages or move backwards", async () => {
  const { store, principal, lease, claim, acknowledge } = await setup()
  await claim()
  await expect(
    store.acknowledgeRun(principal, {
      ...lease,
      controlVersion: 1,
      throughSequence: 2,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" })
  await acknowledge()
  await expect(
    store.acknowledgeRun(principal, {
      ...lease,
      controlVersion: 1,
      throughSequence: 0,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" })
})

test("another member, worker or mismatched credential cannot access a task", async () => {
  const { store, otherId, principal, runInput, lease, report, claim } =
    await setup()
  await claim()
  await expect(
    store.claimRun({ ...principal, userId: otherId }, runInput),
  ).rejects.toMatchObject({ code: "not_found" })
  await expect(
    store.getWork({ ...principal, workerId: "intruder" }, runInput),
  ).rejects.toMatchObject({ code: "lease_lost" })
  await expect(
    store.renewLease(principal, { ...lease, generation: 2 }),
  ).rejects.toMatchObject({ code: "lease_lost" })
  await expect(
    store.reportRun({ ...principal, credentialId: "missing" }, report),
  ).rejects.toMatchObject({ code: "credential_revoked" })
})

test("token revocation and trashed drawings block worker writes", async () => {
  const first = await setup()
  await first.claim()
  await first.acknowledge()
  await db.delete(accessTokens).where(eq(accessTokens.id, first.tokenId))
  await expect(
    first.store.renewLease(first.principal, first.lease),
  ).rejects.toMatchObject({ code: "credential_revoked" })
  await expect(
    first.store.reportRun(first.principal, first.report),
  ).rejects.toMatchObject({ code: "credential_revoked" })
  const second = await setup()
  await second.claim()
  await second.acknowledge()
  await db
    .update(drawings)
    .set({ deletedAt: new Date(), trashRootId: second.drawingId })
    .where(eq(drawings.id, second.drawingId))
  await expect(
    second.store.reportRun(second.principal, second.report),
  ).rejects.toMatchObject({ code: "not_found" })
})

test("OAuth grants provide stable identity across token rotation and fail after expiry", async () => {
  const { store, ownerId, principal, runInput, lease, report, advance } =
    await setup()
  const clientId = randomUUID()
  const grantId = randomUUID()
  await db.insert(oauthClients).values({
    id: clientId,
    name: "Codex",
    redirectUris: ["http://localhost/callback"],
  })
  await db.insert(oauthGrants).values({
    id: grantId,
    userId: ownerId,
    clientId,
    redirectUri: "http://localhost/callback",
    codeChallenge: "pkce",
    codeExpiresAt: new Date(),
    accessTokenHash: "access-hash",
    accessTokenExpiresAt: new Date("2026-11-25T12:01:00Z"),
  })
  const oauth = {
    ...principal,
    credentialKind: "oauth_grant" as const,
    credentialId: grantId,
  }
  await store.claimRun(oauth, runInput)
  await store.acknowledgeRun(oauth, {
    ...lease,
    controlVersion: 1,
    throughSequence: 1,
  })
  await db
    .update(oauthGrants)
    .set({ accessTokenHash: "rotated-hash" })
    .where(eq(oauthGrants.id, grantId))
  expect((await store.renewLease(oauth, lease)).credentialId).toBe(grantId)
  advance(60_000)
  await expect(store.reportRun(oauth, report)).rejects.toMatchObject({
    code: "credential_revoked",
  })
})

test("retrying an already committed progress report during pause creates no new work", async () => {
  const {
    store,
    ownerId,
    principal,
    runInput,
    report,
    claim,
    acknowledge,
    control,
  } = await setup()
  await claim()
  await acknowledge()
  const progress = {
    ...report,
    kind: "progress",
    body: "Read the existing drawing.",
  }
  const receipt = await store.reportRun(principal, progress)
  await control("pause", 1)
  expect(await store.reportRun(principal, progress)).toEqual(receipt)
  expect(
    (await store.getConversation(ownerId, runInput)).activeRun,
  ).toMatchObject({ control: "paused", controlVersion: 2 })
  expect(
    (await store.listMessages(ownerId, runInput)).items.map(
      (message) => message.kind,
    ),
  ).toEqual(["user", "assistant", "pause"])
})

test("credentials of a different member cannot be bound to an owned task", async () => {
  const { store, otherId, principal, runInput } = await setup()
  const tokenId = randomUUID()
  await db.insert(accessTokens).values({
    id: tokenId,
    userId: otherId,
    name: "Other",
    tokenHash: randomUUID(),
    start: "exs_other",
  })
  await expect(
    store.claimRun({ ...principal, credentialId: tokenId }, runInput),
  ).rejects.toMatchObject({ code: "credential_revoked" })
})
