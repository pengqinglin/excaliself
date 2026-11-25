import { randomInt, randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Db } from "@/db"
import { assistantOperations, assistantRuns, drawings } from "@/db/schema"
import type { SceneElement } from "@/features/collab/protocol"
import {
  installCommittedScene,
  type RoomRegistry,
  withRoomScene,
} from "@/features/collab/room-session"
import { mergeSceneElements } from "@/features/collab/scene-store"
import { withEdit } from "@/features/drawing-edits/apply"
import { sceneText } from "@/features/drawings/search"
import { ASSISTANT_UNDO_RETENTION_MS } from "./limits"
import {
  operationReceipt,
  requireStoredImages,
  validateSceneSize,
} from "./scene"
import { identifier, parseInput } from "./schemas"
import { AssistantError } from "./state"
import {
  activeRun,
  appendEvent,
  appendMessage,
  assertSameRequest,
  eventData,
  findConversation,
  lockConversation,
  lockRun,
  requestHash,
} from "./storage"
import type { Clock } from "./types"

export const revertInput = z.object({
  conversationId: identifier,
  operationId: identifier,
  requestId: identifier,
})

export function createAssistantRevertStore(
  db: Db,
  registry: RoomRegistry,
  now: Clock = () => new Date(),
) {
  return {
    async revertOperation(userId: string, raw: unknown) {
      const input = parseInput(revertInput, raw)
      const hash = requestHash(["undo", userId, input])
      const found = await findConversation(db, userId, input.conversationId)
      return withRoomScene(registry, found.drawingId, async (room) => {
        const result = await db.transaction(async (tx) => {
          const conversation = await lockConversation(
            tx,
            userId,
            input.conversationId,
            true,
            true,
          )
          const [duplicate] = await tx
            .select()
            .from(assistantOperations)
            .where(
              and(
                eq(assistantOperations.conversationId, conversation.id),
                eq(assistantOperations.requestId, input.requestId),
              ),
            )
          if (duplicate) {
            assertSameRequest(duplicate.requestHash, hash)
            return { operation: duplicate, applied: false as const }
          }
          const [operation] = await tx
            .select()
            .from(assistantOperations)
            .where(
              and(
                eq(assistantOperations.conversationId, conversation.id),
                eq(assistantOperations.id, input.operationId),
              ),
            )
          if (!operation)
            throw new AssistantError("not_found", "Operation not found.")
          const [previous] = await tx
            .select()
            .from(assistantOperations)
            .where(eq(assistantOperations.undoOf, operation.id))
          if (previous) return { operation: previous, applied: false as const }
          const timestamp = now()
          if (
            operation.undoOf ||
            operation.createdAt.getTime() <
              timestamp.getTime() - ASSISTANT_UNDO_RETENTION_MS
          )
            throw new AssistantError(
              "scene_conflict",
              "The operation is outside its revert window.",
            )
          const current = new Map(
            room.elements.map((element) => [element.id, element]),
          )
          const before = new Map(
            operation.before.map((element) => [element.id, element]),
          )
          const restored: SceneElement[] = operation.after.map((after) => {
            const element = current.get(after.id)
            if (
              !element ||
              element.version !== after.version ||
              element.versionNonce !== after.versionNonce
            )
              throw new AssistantError(
                "scene_conflict",
                "The affected elements have changed since this operation.",
              )
            return {
              ...(before.get(after.id) ?? { ...element, isDeleted: true }),
              version: element.version + 1,
              versionNonce: randomInt(1, 2 ** 31),
              updated: timestamp.getTime(),
            }
          })
          const settings = { ...room.settings }
          for (const key of Object.keys(
            operation.afterSettings ?? {},
          ) as (keyof typeof settings)[]) {
            if (settings[key] !== operation.afterSettings?.[key])
              throw new AssistantError(
                "scene_conflict",
                "The affected drawing settings have changed.",
              )
            Object.assign(settings, { [key]: operation.beforeSettings?.[key] })
          }
          const next = withEdit(room.elements, restored)
          validateSceneSize(next)
          await requireStoredImages(tx, found.drawingId, restored)
          const [drawing] = await tx
            .select({ data: drawings.data })
            .from(drawings)
            .where(eq(drawings.id, found.drawingId))
          const [saved] = await tx
            .update(drawings)
            .set({
              data: mergeSceneElements(drawing.data, next, settings),
              searchText: sceneText(next),
              sceneRevision: sql`${drawings.sceneRevision} + 1`,
              updatedAt: timestamp,
            })
            .where(eq(drawings.id, found.drawingId))
            .returning({ revision: drawings.sceneRevision })
          let run = await lockRun(tx, conversation.id, operation.runId)
          const active = await activeRun(tx, conversation.id)
          if (active && active.control !== "paused") {
            const [paused] = await tx
              .update(assistantRuns)
              .set({
                control: "paused",
                controlVersion: active.controlVersion + 1,
                lastInputSequence: conversation.nextMessageSequence,
                updatedAt: timestamp,
              })
              .where(eq(assistantRuns.id, active.id))
              .returning()
            const message = await appendMessage(
              tx,
              conversation,
              {
                runId: active.id,
                source: "member",
                kind: "pause",
                body: null,
                requestId: `undo:${input.requestId}`,
                requestHash: hash,
              },
              timestamp,
            )
            await appendEvent(
              tx,
              conversation,
              {
                runId: active.id,
                kind: "run_controlled",
                data: eventData(paused, message),
              },
              timestamp,
            )
            if (run.id === paused.id) run = paused
          }
          const [inverse] = await tx
            .insert(assistantOperations)
            .values({
              id: randomUUID(),
              conversationId: conversation.id,
              runId: run.id,
              requestId: input.requestId,
              requestHash: hash,
              summary: operation.summary,
              before: operation.after,
              after: restored,
              beforeSettings: operation.afterSettings,
              afterSettings: operation.beforeSettings,
              undoOf: operation.id,
              sceneRevision: saved.revision,
              createdAt: timestamp,
            })
            .returning()
          await tx
            .update(assistantOperations)
            .set({ revertedAt: timestamp })
            .where(eq(assistantOperations.id, operation.id))
          await appendEvent(
            tx,
            conversation,
            {
              runId: run.id,
              kind: "scene_committed",
              data: {
                ...eventData(run),
                operationId: inverse.id,
                undoOf: operation.id,
                sceneRevision: saved.revision,
              },
            },
            timestamp,
          )
          return { operation: inverse, applied: true as const, next, settings }
        })
        if (result.applied)
          installCommittedScene(
            registry,
            room,
            result.next,
            result.operation.after,
            result.settings,
          )
        return {
          status: "saved" as const,
          replayed: !result.applied,
          ...operationReceipt(result.operation),
        }
      })
    },
  }
}
