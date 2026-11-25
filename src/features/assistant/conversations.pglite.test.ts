// @vitest-environment node
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { Db } from "@/db"
import { drawings } from "@/db/schema"
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
  const store = createAssistantStore(db)
  const conversation = await store.getOrCreateConversation(seed.ownerId, {
    drawingId: seed.drawingId,
  })
  return { ...seed, store, conversation, conversationId: conversation.id }
}

test("opening a conversation again returns the member's existing conversation", async () => {
  const { store, ownerId, drawingId, conversation } = await setup()
  expect(await store.getOrCreateConversation(ownerId, { drawingId })).toEqual(
    conversation,
  )
  expect(
    await store.getConversation(ownerId, { conversationId: conversation.id }),
  ).toMatchObject({ conversation, activeRun: null, latestRun: null })
})

test("newest-first history pages preserve sequence across new arrivals and deny other members", async () => {
  const { store, ownerId, otherId, conversationId } = await setup()
  for (let index = 1; index <= 12; index++)
    await store.sendInstruction(ownerId, {
      conversationId,
      requestId: `message-${index}`,
      body: `Message ${index}`,
    })
  const newest = await store.recentMessages(ownerId, {
    conversationId,
    limit: 5,
  })
  expect(newest.items.map((message) => message.sequence)).toEqual([
    8, 9, 10, 11, 12,
  ])
  expect(newest.hasMore).toBe(true)
  await store.sendInstruction(ownerId, {
    conversationId,
    requestId: "new-arrival",
    body: "New message",
  })
  const older = await store.recentMessages(ownerId, {
    conversationId,
    beforeSequence: newest.previousCursor,
    limit: 5,
  })
  expect(older.items.map((message) => message.sequence)).toEqual([
    3, 4, 5, 6, 7,
  ])
  expect(
    (
      await store.recentMessages(ownerId, {
        conversationId,
        beforeSequence: older.previousCursor,
        limit: 5,
      })
    ).items.map((message) => message.sequence),
  ).toEqual([1, 2])
  await expect(
    store.recentMessages(otherId, { conversationId }),
  ).rejects.toMatchObject({ code: "not_found" })
})

test("Team members have separate conversations and cannot read or write each other's", async () => {
  const { store, ownerId, otherId, teamId, drawingId, conversationId } =
    await setup()
  const own = await store.getOrCreateConversation(ownerId, {
    drawingId: teamId,
  })
  const other = await store.getOrCreateConversation(otherId, {
    drawingId: teamId,
  })
  expect(own.id).not.toBe(other.id)
  await expect(
    store.getOrCreateConversation(otherId, { drawingId }),
  ).rejects.toMatchObject({ code: "not_found" })
  await store.sendInstruction(ownerId, {
    conversationId: own.id,
    requestId: "secret",
    body: "Private instruction",
  })
  for (const id of [own.id, conversationId, "missing"]) {
    await expect(
      store.getConversation(otherId, { conversationId: id }),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      store.listMessages(otherId, { conversationId: id }),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      store.listEvents(otherId, { conversationId: id }),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      store.sendInstruction(otherId, {
        conversationId: id,
        requestId: "intrusion",
        body: "Read this",
      }),
    ).rejects.toMatchObject({ code: "not_found" })
  }
})

test("the first instruction creates a task and later messages advance its input version", async () => {
  const { store, ownerId, conversationId } = await setup()
  const first = await store.sendInstruction(ownerId, {
    conversationId,
    requestId: "one",
    body: "Continue this diagram",
  })
  const second = await store.sendInstruction(ownerId, {
    conversationId,
    requestId: "two",
    body: "Keep the existing labels",
  })
  expect(first.run).toMatchObject({
    status: "queued",
    controlVersion: 1,
    firstInputSequence: 1,
  })
  expect(second.run).toMatchObject({
    id: first.run.id,
    status: "queued",
    controlVersion: 2,
    lastInputSequence: 2,
  })
  expect(second.message.sequence).toBe(2)
})

test("message retries reuse the same record; reusing an ID for other content fails", async () => {
  const { store, ownerId, conversationId } = await setup()
  const input = {
    conversationId,
    requestId: "retry",
    body: "  Align the nodes  ",
  }
  const first = await store.sendInstruction(ownerId, input)
  const retry = await createAssistantStore(db).sendInstruction(ownerId, input)
  expect(retry.message).toEqual(first.message)
  expect(retry.run.controlVersion).toBe(1)
  await expect(
    store.sendInstruction(ownerId, { ...input, body: "Different" }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" })
  expect(
    (await store.listMessages(ownerId, { conversationId })).items,
  ).toHaveLength(1)
  expect(
    (await store.listEvents(ownerId, { conversationId })).items.map(
      (event) => event.kind,
    ),
  ).toEqual(["run_created", "message_created"])
})

test("invalid requests leave message/event counters and the active task unchanged", async () => {
  const { store, ownerId, conversationId } = await setup()
  await expect(
    store.sendInstruction(ownerId, {
      conversationId,
      requestId: "empty",
      body: " \n ",
    }),
  ).rejects.toMatchObject({ code: "invalid_input" })
  expect(
    await store.getConversation(ownerId, { conversationId }),
  ).toMatchObject({
    conversation: { nextMessageSequence: 1, nextEventSequence: 1 },
    activeRun: null,
  })
})

test("exclusive sequence cursors paginate messages and events without duplicates", async () => {
  const { store, ownerId, conversationId } = await setup()
  for (let index = 0; index < 5; index++)
    await store.sendInstruction(ownerId, {
      conversationId,
      requestId: `request-${index}`,
      body: `Instruction ${index}`,
    })
  const page1 = await store.listMessages(ownerId, { conversationId, limit: 2 })
  const page2 = await store.listMessages(ownerId, {
    conversationId,
    limit: 2,
    afterSequence: page1.nextCursor,
  })
  const page3 = await store.listMessages(ownerId, {
    conversationId,
    limit: 2,
    afterSequence: page2.nextCursor,
  })
  expect(
    [...page1.items, ...page2.items, ...page3.items].map(
      (message) => message.sequence,
    ),
  ).toEqual([1, 2, 3, 4, 5])
  expect([page1.hasMore, page2.hasMore, page3.hasMore]).toEqual([
    true,
    true,
    false,
  ])
  expect(
    await store.listMessages(ownerId, { conversationId, afterSequence: 5 }),
  ).toEqual({ items: [], nextCursor: 5, hasMore: false })
  const events = await store.listEvents(ownerId, { conversationId, limit: 3 })
  expect(events.items.map((event) => event.sequence)).toEqual([1, 2, 3])
  expect(
    (
      await store.listEvents(ownerId, {
        conversationId,
        afterSequence: events.nextCursor,
      })
    ).items.map((event) => event.sequence),
  ).toEqual([4, 5, 6])
})

test("history remains readable in trash but new conversation/message writes fail", async () => {
  const { store, ownerId, drawingId, conversationId } = await setup()
  await store.sendInstruction(ownerId, {
    conversationId,
    requestId: "before-trash",
    body: "Keep history",
  })
  await db
    .update(drawings)
    .set({ deletedAt: new Date(), trashRootId: drawingId })
    .where(eq(drawings.id, drawingId))
  expect(
    (await store.listMessages(ownerId, { conversationId })).items,
  ).toHaveLength(1)
  expect(
    (await store.getConversation(ownerId, { conversationId })).activeRun,
  ).not.toBeNull()
  await expect(
    store.getOrCreateConversation(ownerId, { drawingId }),
  ).rejects.toMatchObject({ code: "not_found" })
  await expect(
    store.sendInstruction(ownerId, {
      conversationId,
      requestId: "after-trash",
      body: "No write",
    }),
  ).rejects.toMatchObject({ code: "not_found" })
})

test("changing the drawing's access revokes access even for the conversation owner", async () => {
  const { store, ownerId, otherId, teamId } = await setup()
  const conversation = await store.getOrCreateConversation(otherId, {
    drawingId: teamId,
  })
  await db
    .update(drawings)
    .set({ space: "private", createdBy: ownerId })
    .where(eq(drawings.id, teamId))
  await expect(
    store.listMessages(otherId, { conversationId: conversation.id }),
  ).rejects.toMatchObject({ code: "not_found" })
})
