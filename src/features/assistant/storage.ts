import { createHash, randomUUID } from "node:crypto"
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm"
import type { Db } from "@/db"
import {
  assistantConversations,
  assistantEvents,
  assistantMessages,
  assistantRuns,
  drawings,
} from "@/db/schema"
import { accessibleTo } from "@/features/spaces/access"
import { AssistantError } from "./state"
import type {
  AssistantMessage,
  AssistantRun,
  Conversation,
  EventData,
  Page,
} from "./types"

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select">

export const requestHash = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex")

export function assertSameRequest(actual: string | null, expected: string) {
  if (actual !== expected)
    throw new AssistantError(
      "idempotency_conflict",
      "This request ID was already used for different content.",
    )
}

export async function findConversation(db: Reader, userId: string, id: string) {
  const [row] = await db
    .select({ conversation: assistantConversations })
    .from(assistantConversations)
    .innerJoin(drawings, eq(drawings.id, assistantConversations.drawingId))
    .where(
      and(
        eq(assistantConversations.id, id),
        eq(assistantConversations.userId, userId),
        accessibleTo(drawings, userId),
      ),
    )
  if (!row) throw new AssistantError("not_found", "Conversation not found.")
  return row.conversation
}

/** Lock order for every mutation: drawing, conversation, run, credential. */
export async function lockDrawing(
  tx: Tx,
  userId: string,
  id: string,
  writable: boolean,
  exclusive = false,
) {
  const [drawing] = await tx
    .select({ id: drawings.id })
    .from(drawings)
    .where(
      and(
        eq(drawings.id, id),
        accessibleTo(drawings, userId),
        writable ? isNull(drawings.deletedAt) : undefined,
      ),
    )
    .for(exclusive ? "update" : "share")
  if (!drawing) throw new AssistantError("not_found", "Drawing not found.")
}

export async function lockConversation(
  tx: Tx,
  userId: string,
  id: string,
  writable = true,
  exclusive = false,
) {
  const found = await findConversation(tx, userId, id)
  await lockDrawing(tx, userId, found.drawingId, writable, exclusive)
  const [conversation] = await tx
    .select()
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.id, id),
        eq(assistantConversations.userId, userId),
      ),
    )
    .for("update")
  if (!conversation)
    throw new AssistantError("not_found", "Conversation not found.")
  return conversation
}

export async function findRun(db: Reader, conversationId: string, id: string) {
  const [run] = await db
    .select()
    .from(assistantRuns)
    .where(
      and(
        eq(assistantRuns.id, id),
        eq(assistantRuns.conversationId, conversationId),
      ),
    )
  if (!run) throw new AssistantError("not_found", "Task not found.")
  return run
}

export async function lockRun(tx: Tx, conversationId: string, id: string) {
  const [run] = await tx
    .select()
    .from(assistantRuns)
    .where(
      and(
        eq(assistantRuns.id, id),
        eq(assistantRuns.conversationId, conversationId),
      ),
    )
    .for("update")
  if (!run) throw new AssistantError("not_found", "Task not found.")
  return run
}

export async function activeRun(db: Reader, conversationId: string) {
  const [run] = await db
    .select()
    .from(assistantRuns)
    .where(
      and(
        eq(assistantRuns.conversationId, conversationId),
        inArray(assistantRuns.status, ["queued", "running", "awaiting_input"]),
      ),
    )
  return run ?? null
}

export async function latestRun(db: Reader, conversationId: string) {
  const [run] = await db
    .select()
    .from(assistantRuns)
    .where(eq(assistantRuns.conversationId, conversationId))
    .orderBy(desc(assistantRuns.firstInputSequence))
    .limit(1)
  return run ?? null
}

export async function previousMemberMessage(
  tx: Tx,
  conversationId: string,
  requestId: string,
) {
  const [message] = await tx
    .select()
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.conversationId, conversationId),
        eq(assistantMessages.source, "member"),
        eq(assistantMessages.requestId, requestId),
      ),
    )
  return message
}

export async function appendMessage(
  tx: Tx,
  conversation: Conversation,
  input: Omit<
    typeof assistantMessages.$inferInsert,
    "id" | "conversationId" | "sequence"
  >,
  now: Date,
) {
  const [message] = await tx
    .insert(assistantMessages)
    .values({
      ...input,
      id: randomUUID(),
      conversationId: conversation.id,
      sequence: conversation.nextMessageSequence,
      createdAt: now,
    })
    .returning()
  conversation.nextMessageSequence += 1
  await tx
    .update(assistantConversations)
    .set({
      nextMessageSequence: conversation.nextMessageSequence,
      updatedAt: now,
    })
    .where(eq(assistantConversations.id, conversation.id))
  return message
}

export function eventData(
  run: AssistantRun,
  message?: AssistantMessage,
): EventData {
  return {
    status: run.status,
    control: run.control,
    controlVersion: run.controlVersion,
    ...(message && {
      messageId: message.id,
      messageSequence: message.sequence,
    }),
  }
}

export async function appendEvent(
  tx: Tx,
  conversation: Conversation,
  input: Omit<
    typeof assistantEvents.$inferInsert,
    "id" | "conversationId" | "sequence"
  >,
  now: Date,
) {
  const [event] = await tx
    .insert(assistantEvents)
    .values({
      ...input,
      id: randomUUID(),
      conversationId: conversation.id,
      sequence: conversation.nextEventSequence,
      createdAt: now,
    })
    .returning()
  conversation.nextEventSequence += 1
  await tx
    .update(assistantConversations)
    .set({ nextEventSequence: conversation.nextEventSequence, updatedAt: now })
    .where(eq(assistantConversations.id, conversation.id))
  return event
}

export function pageOf<T extends { sequence: number }>(
  rows: T[],
  afterSequence: number,
  limit: number,
): Page<T> {
  const items = rows.slice(0, limit)
  return {
    items,
    hasMore: rows.length > limit,
    nextCursor: items.at(-1)?.sequence ?? afterSequence,
  }
}

export async function messagePage(
  db: Reader,
  conversationId: string,
  afterSequence: number,
  limit: number,
) {
  return pageOf(
    await db
      .select()
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.conversationId, conversationId),
          gt(assistantMessages.sequence, afterSequence),
        ),
      )
      .orderBy(asc(assistantMessages.sequence))
      .limit(limit + 1),
    afterSequence,
    limit,
  )
}
