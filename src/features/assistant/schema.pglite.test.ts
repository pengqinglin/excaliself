// @vitest-environment node
import { PGlite } from "@electric-sql/pglite"
import { eq, sql } from "drizzle-orm"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { drizzle } from "drizzle-orm/pglite"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Db } from "@/db"
import {
  assistantConversations,
  assistantEvents,
  assistantMessages,
  assistantRuns,
  drawings,
  users,
} from "@/db/schema"
import { createAssistantTestDb, seedAssistantTest } from "./test-support"

let db: Db
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await createAssistantTestDb())
}, 30_000)
afterAll(async () => close?.())

async function setup() {
  const seed = await seedAssistantTest(db)
  const [conversation] = await db
    .insert(assistantConversations)
    .values({
      id: `${seed.ownerId}-conversation`,
      userId: seed.ownerId,
      drawingId: seed.drawingId,
    })
    .returning()
  const [run] = await db
    .insert(assistantRuns)
    .values({
      id: `${seed.ownerId}-run`,
      conversationId: conversation.id,
      firstInputSequence: 1,
      lastInputSequence: 1,
    })
    .returning()
  return { ...seed, conversation, run }
}

test("a member/drawing has one conversation and one unfinished task", async () => {
  const { conversation, run } = await setup()
  await expect(
    db.insert(assistantConversations).values({
      ...conversation,
      id: "duplicate-conversation",
    }),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
  await expect(
    db.insert(assistantRuns).values({
      ...run,
      id: "duplicate-run",
    }),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
  await db
    .update(assistantRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(assistantRuns.id, run.id))
  await db.insert(assistantRuns).values({ ...run, id: "next-run" })
})

test("the database rejects invalid states, counters and partial leases", async () => {
  const { conversation, run } = await setup()
  for (const update of [
    { status: sql`'invented'` },
    { controlVersion: 0 },
    { acknowledgedControlVersion: 2 },
    { status: "completed" as const },
    { leaseGeneration: 1 },
    {
      workerId: "fake",
      credentialId: "fake",
      credentialKind: sql`null`,
      workerState: "working" as const,
      leaseGeneration: 1,
    },
  ])
    await expect(
      db.update(assistantRuns).set(update).where(eq(assistantRuns.id, run.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } })
  await expect(
    db
      .update(assistantConversations)
      .set({ nextMessageSequence: 0 })
      .where(eq(assistantConversations.id, conversation.id)),
  ).rejects.toMatchObject({ cause: { code: "23514" } })
})

test("message role, sequence and deduplication are constrained in storage", async () => {
  const { conversation, run } = await setup()
  const message = {
    id: `${run.id}-message`,
    conversationId: conversation.id,
    runId: run.id,
    sequence: 1,
    source: "member" as const,
    kind: "user" as const,
    body: "Hello",
    requestId: "request",
    requestHash: "digest",
  }
  await db.insert(assistantMessages).values(message)
  await expect(
    db
      .insert(assistantMessages)
      .values({ ...message, id: "sequence-duplicate", requestId: "second" }),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
  await expect(
    db
      .insert(assistantMessages)
      .values({ ...message, id: "request-duplicate", sequence: 2 }),
  ).rejects.toMatchObject({ cause: { code: "23505" } })
  await expect(
    db.insert(assistantMessages).values({
      ...message,
      id: "invalid-role",
      source: "worker",
      sequence: 2,
      requestId: "role",
    }),
  ).rejects.toMatchObject({ cause: { code: "23514" } })
})

test("messages and events cannot reference another conversation's task", async () => {
  const first = await setup()
  const second = await setup()
  await expect(
    db.insert(assistantMessages).values({
      id: "cross-message",
      conversationId: first.conversation.id,
      runId: second.run.id,
      sequence: 1,
      source: "member",
      kind: "user",
      body: "Hello",
      requestId: "cross",
      requestHash: "digest",
    }),
  ).rejects.toMatchObject({ cause: { code: "23503" } })
  await expect(
    db.insert(assistantEvents).values({
      id: "cross-event",
      conversationId: first.conversation.id,
      runId: second.run.id,
      sequence: 1,
      kind: "run_created",
      data: { status: "queued", control: "running", controlVersion: 1 },
    }),
  ).rejects.toMatchObject({ cause: { code: "23503" } })
})

test("deleting a drawing or its member cascades private assistant data", async () => {
  for (const target of ["drawing", "member"]) {
    const { drawingId, ownerId, conversation } = await setup()
    if (target === "drawing")
      await db.delete(drawings).where(eq(drawings.id, drawingId))
    else
      await db
        .delete(drawings)
        .where(eq(drawings.createdBy, ownerId))
        .then(() => db.delete(users).where(eq(users.id, ownerId)))
    expect(
      await db
        .select()
        .from(assistantConversations)
        .where(eq(assistantConversations.id, conversation.id)),
    ).toEqual([])
    expect(
      await db
        .select()
        .from(assistantRuns)
        .where(eq(assistantRuns.conversationId, conversation.id)),
    ).toEqual([])
  }
})

test("the new migration upgrades an old schema without changing existing drawings", async () => {
  const client = new PGlite()
  try {
    const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" })
    // 0019 is the assistant migration; later migrations must not change this boundary.
    const assistantMigrationIndex = 19
    for (const migration of migrations.slice(0, assistantMigrationIndex))
      for (const statement of migration.sql) await client.exec(statement)
    const legacy = drizzle(client)
    await legacy
      .insert(users)
      .values({ id: "legacy", email: "legacy@example.com", name: "Legacy" })
    // Construct legacy data with the columns that existed at this boundary.
    await legacy.execute(
      sql`insert into drawings (id, name, "createdBy", data, "createdAt", "updatedAt") values ('legacy-drawing', 'Keep me', 'legacy', '{"elements":[]}', now(), now())`,
    )
    for (const statement of migrations[assistantMigrationIndex].sql)
      await client.exec(statement)
    expect(
      await legacy
        .select({ name: drawings.name, data: drawings.data })
        .from(drawings),
    ).toEqual([{ name: "Keep me", data: '{"elements":[]}' }])
    await legacy
      .insert(assistantConversations)
      .values({ id: "upgraded", userId: "legacy", drawingId: "legacy-drawing" })
  } finally {
    await client.close()
  }
}, 30_000)
