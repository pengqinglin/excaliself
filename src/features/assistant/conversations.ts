import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, gt, lt } from "drizzle-orm"
import type { Db } from "@/db"
import {
  assistantConversations,
  assistantEvents,
  assistantMessages,
  assistantRuns,
} from "@/db/schema"
import {
  conversationInput,
  drawingInput,
  historyInput,
  instructionInput,
  pageInput,
  parseInput,
} from "./schemas"
import { leaseIsLive } from "./state"
import {
  activeRun,
  appendEvent,
  appendMessage,
  assertSameRequest,
  eventData,
  findConversation,
  findRun,
  latestRun,
  lockConversation,
  lockDrawing,
  messagePage,
  pageOf,
  previousMemberMessage,
  requestHash,
} from "./storage"
import type { Clock } from "./types"

export function createConversationStore(db: Db, now: Clock) {
  return {
    async getOrCreateConversation(userId: string, raw: unknown) {
      const { drawingId } = parseInput(drawingInput, raw)
      return db.transaction(async (tx) => {
        await lockDrawing(tx, userId, drawingId, true)
        const timestamp = now()
        await tx
          .insert(assistantConversations)
          .values({
            id: randomUUID(),
            userId,
            drawingId,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing({
            target: [
              assistantConversations.userId,
              assistantConversations.drawingId,
            ],
          })
        const [conversation] = await tx
          .select()
          .from(assistantConversations)
          .where(
            and(
              eq(assistantConversations.userId, userId),
              eq(assistantConversations.drawingId, drawingId),
            ),
          )
        return conversation
      })
    },

    async getConversation(userId: string, raw: unknown) {
      const { conversationId } = parseInput(conversationInput, raw)
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          userId,
          conversationId,
          false,
        )
        return {
          conversation,
          activeRun: await activeRun(tx, conversationId),
          latestRun: await latestRun(tx, conversationId),
        }
      })
    },

    async listMessages(userId: string, raw: unknown) {
      const { conversationId, afterSequence, limit } = parseInput(
        pageInput,
        raw,
      )
      await findConversation(db, userId, conversationId)
      return messagePage(db, conversationId, afterSequence, limit)
    },

    async recentMessages(userId: string, raw: unknown) {
      const input = parseInput(historyInput, raw)
      await findConversation(db, userId, input.conversationId)
      const rows = await db
        .select()
        .from(assistantMessages)
        .where(
          and(
            eq(assistantMessages.conversationId, input.conversationId),
            input.beforeSequence
              ? lt(assistantMessages.sequence, input.beforeSequence)
              : undefined,
          ),
        )
        .orderBy(desc(assistantMessages.sequence))
        .limit(input.limit + 1)
      const items = rows.slice(0, input.limit).reverse()
      return {
        items,
        hasMore: rows.length > input.limit,
        previousCursor: items[0]?.sequence,
      }
    },

    async listEvents(userId: string, raw: unknown) {
      const { conversationId, afterSequence, limit } = parseInput(
        pageInput,
        raw,
      )
      await findConversation(db, userId, conversationId)
      return pageOf(
        await db
          .select()
          .from(assistantEvents)
          .where(
            and(
              eq(assistantEvents.conversationId, conversationId),
              gt(assistantEvents.sequence, afterSequence),
            ),
          )
          .orderBy(asc(assistantEvents.sequence))
          .limit(limit + 1),
        afterSequence,
        limit,
      )
    },

    async sendInstruction(userId: string, raw: unknown) {
      const input = parseInput(instructionInput, raw)
      const hash = requestHash({ kind: "user", body: input.body })
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          userId,
          input.conversationId,
        )
        const previous = await previousMemberMessage(
          tx,
          conversation.id,
          input.requestId,
        )
        if (previous) {
          assertSameRequest(previous.requestHash, hash)
          return {
            message: previous,
            run: await findRun(tx, conversation.id, previous.runId),
          }
        }
        const timestamp = now()
        let run = await activeRun(tx, conversation.id)
        if (!run) {
          ;[run] = await tx
            .insert(assistantRuns)
            .values({
              id: randomUUID(),
              conversationId: conversation.id,
              firstInputSequence: conversation.nextMessageSequence,
              lastInputSequence: conversation.nextMessageSequence,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning()
          await appendEvent(
            tx,
            conversation,
            { runId: run.id, kind: "run_created", data: eventData(run) },
            timestamp,
          )
        } else {
          ;[run] = await tx
            .update(assistantRuns)
            .set({
              controlVersion: run.controlVersion + 1,
              lastInputSequence: conversation.nextMessageSequence,
              status: leaseIsLive(run, timestamp) ? "running" : "queued",
              updatedAt: timestamp,
            })
            .where(eq(assistantRuns.id, run.id))
            .returning()
        }
        const message = await appendMessage(
          tx,
          conversation,
          {
            runId: run.id,
            source: "member",
            kind: "user",
            body: input.body,
            requestId: input.requestId,
            requestHash: hash,
          },
          timestamp,
        )
        await appendEvent(
          tx,
          conversation,
          {
            runId: run.id,
            kind: "message_created",
            data: eventData(run, message),
          },
          timestamp,
        )
        return { message, run }
      })
    },
  }
}
