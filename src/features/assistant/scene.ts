import { randomUUID } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import { generateKeyBetween } from "fractional-indexing"
import { z } from "zod"
import type { Db } from "@/db"
import { assistantOperations, drawingFiles, drawings } from "@/db/schema"
import type { SceneElement } from "@/features/collab/protocol"
import { parseClientMessage } from "@/features/collab/protocol"
import {
  installCommittedScene,
  MAX_ROOM_ELEMENTS,
  MAX_ROOM_SCENE_BYTES,
  type RoomRegistry,
  withRoomScene,
} from "@/features/collab/room-session"
import type { SceneSettings } from "@/features/collab/scene-settings"
import { mergeSceneElements } from "@/features/collab/scene-store"
import { withEdit } from "@/features/drawing-edits/apply"
import { referencedFileIds } from "@/features/drawings/scene-write"
import { sceneText } from "@/features/drawings/search"
import { elementChange, planEdit } from "@/features/mcp/scene/edit"
import { elementSkeleton, MAX_ELEMENTS } from "@/features/mcp/scene/skeleton"
import { summarizeScene } from "@/features/mcp/summary"
import { ASSISTANT_UNDO_RETENTION_MS } from "./limits"
import { assertCurrentWork, assertLease, validCredential } from "./runs"
import {
  identifier,
  leaseInput,
  parseInput,
  principalInput,
  version,
} from "./schemas"
import { AssistantError } from "./state"
import {
  appendEvent,
  assertSameRequest,
  eventData,
  findConversation,
  lockConversation,
  lockRun,
  requestHash,
} from "./storage"
import type { Clock, WorkerPrincipal } from "./types"

export const sceneWorkInput = leaseInput.extend({ controlVersion: version })
export const sceneSettingsInput = z.object({
  viewBackgroundColor: z
    .string()
    .regex(
      /^(?:transparent|#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8}))$/i,
    ),
  gridSize: z.number().positive().max(10_000),
  gridStep: z.number().positive().max(10_000),
  gridModeEnabled: z.boolean(),
})
export const commitEditInput = sceneWorkInput.extend({
  requestId: identifier,
  summary: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !value.includes("\0")),
  base: z.record(
    z.string().min(1).max(128),
    z.object({ version, versionNonce: z.number().int().nonnegative() }),
  ),
  add: z.array(elementSkeleton).max(MAX_ELEMENTS).default([]),
  change: z.array(elementChange).max(MAX_ELEMENTS).default([]),
  remove: z.array(identifier).max(MAX_ELEMENTS).default([]),
  settings: z
    .object({ base: sceneSettingsInput, patch: sceneSettingsInput.partial() })
    .optional(),
})

export type Operation = typeof assistantOperations.$inferSelect
export const operationReceipt = (operation: Operation) => ({
  id: operation.id,
  runId: operation.runId,
  summary: operation.summary,
  sceneRevision: operation.sceneRevision,
  createdAt: operation.createdAt,
  changedElements: operation.after.length,
  undoOf: operation.undoOf,
  revertedAt: operation.revertedAt,
})

/** The caller holds the drawing's exclusive lock and has checked current work. */
export async function requireStoredImages(
  tx: Pick<Db, "select">,
  drawingId: string,
  elements: SceneElement[],
) {
  const referenced = referencedFileIds(elements)
  if (referenced.size === 0) return
  const stored = new Set(
    (
      await tx
        .select({ fileId: drawingFiles.fileId })
        .from(drawingFiles)
        .where(eq(drawingFiles.drawingId, drawingId))
    ).map((row) => row.fileId),
  )
  if ([...referenced].some((id) => !stored.has(id)))
    throw new AssistantError(
      "scene_conflict",
      "Wait for the drawing's images to finish uploading, then read the scene again.",
    )
}

export function validateSceneSize(elements: SceneElement[]) {
  if (
    elements.length > MAX_ROOM_ELEMENTS ||
    Buffer.byteLength(JSON.stringify(elements)) > MAX_ROOM_SCENE_BYTES
  )
    throw new AssistantError(
      "invalid_input",
      "The edit exceeds the drawing's scene limit.",
    )
}

/** New elements must already be indexed when their durable receipt is written. */
function indexAddedElements(current: SceneElement[], edited: SceneElement[]) {
  const known = new Set(current.map(({ id }) => id))
  let last: string | null = null
  for (const element of current)
    if (element.index != null && (last === null || element.index > last))
      last = element.index
  return edited.map((element) => {
    if (known.has(element.id)) return element
    last = generateKeyBetween(last, null)
    return { ...element, index: last }
  })
}

/** No model calls here. Every operation is a short, fenced Room command. */
export function createAssistantSceneStore(
  db: Db,
  registry: RoomRegistry,
  now: Clock = () => new Date(),
) {
  return {
    async readScene(rawPrincipal: WorkerPrincipal, raw: unknown) {
      const principal = parseInput(principalInput, rawPrincipal)
      const input = parseInput(sceneWorkInput, raw)
      const found = await findConversation(
        db,
        principal.userId,
        input.conversationId,
      )
      return withRoomScene(registry, found.drawingId, (room) =>
        db.transaction(async (tx) => {
          const conversation = await lockConversation(
            tx,
            principal.userId,
            input.conversationId,
          )
          const run = await lockRun(tx, conversation.id, input.runId)
          assertLease(
            run,
            principal,
            input,
            await validCredential(tx, principal, now),
          )
          assertCurrentWork(run, input.controlVersion)
          if (!room.serverManaged)
            throw new AssistantError(
              "writer_required",
              "Enable server-managed writing in the drawing first.",
            )
          const operations = await tx
            .select({
              id: assistantOperations.id,
              requestId: assistantOperations.requestId,
              summary: assistantOperations.summary,
              sceneRevision: assistantOperations.sceneRevision,
              undoOf: assistantOperations.undoOf,
              revertedAt: assistantOperations.revertedAt,
            })
            .from(assistantOperations)
            .where(eq(assistantOperations.conversationId, conversation.id))
            .orderBy(desc(assistantOperations.sceneRevision))
            .limit(20)
          return {
            drawingId: found.drawingId,
            elements: structuredClone(room.elements),
            settings: { ...room.settings },
            base: Object.fromEntries(
              room.elements.map(({ id, version, versionNonce }) => [
                id,
                { version, versionNonce },
              ]),
            ),
            description: summarizeScene(room.elements),
            operations,
          }
        }),
      )
    },

    async commitEdit(rawPrincipal: WorkerPrincipal, raw: unknown) {
      const principal = parseInput(principalInput, rawPrincipal)
      const input = parseInput(commitEditInput, raw)
      const hash = requestHash([principal, input])
      const found = await findConversation(
        db,
        principal.userId,
        input.conversationId,
      )
      return withRoomScene(registry, found.drawingId, async (room) => {
        const result = await db.transaction(async (tx) => {
          const conversation = await lockConversation(
            tx,
            principal.userId,
            input.conversationId,
            true,
            true,
          )
          const run = await lockRun(tx, conversation.id, input.runId)
          const timestamp = await validCredential(tx, principal, now)
          const [previous] = await tx
            .select()
            .from(assistantOperations)
            .where(
              and(
                eq(assistantOperations.conversationId, conversation.id),
                eq(assistantOperations.requestId, input.requestId),
              ),
            )
          if (previous) {
            assertSameRequest(previous.requestHash, hash)
            return { operation: previous, applied: false as const }
          }
          assertLease(run, principal, input, timestamp)
          assertCurrentWork(run, input.controlVersion)
          const [drawing] = await tx
            .select({
              data: drawings.data,
              serverManagedAt: drawings.serverManagedAt,
            })
            .from(drawings)
            .where(eq(drawings.id, found.drawingId))
          if (!drawing.serverManagedAt || !room.serverManaged)
            throw new AssistantError(
              "writer_required",
              "Enable server-managed writing in the drawing first.",
            )
          if (
            !input.add.length &&
            !input.change.length &&
            !input.remove.length &&
            !Object.keys(input.settings?.patch ?? {}).length
          )
            throw new AssistantError(
              "invalid_input",
              "The edit has no changes.",
            )

          const plan = planEdit(room.elements, input)
          for (const [id, current] of Object.entries(plan.base)) {
            const observed = input.base[id]
            if (
              observed?.version !== current.version ||
              observed.versionNonce !== current.versionNonce
            )
              throw new AssistantError(
                "scene_conflict",
                `Element ${id} changed. Read the scene again before editing.`,
              )
          }
          // A planner's generated id must never replace an existing tombstone.
          const currentIds = new Set(room.elements.map((element) => element.id))
          for (const element of plan.elements)
            if (
              currentIds.has(element.id) &&
              !Object.hasOwn(plan.base, element.id)
            )
              throw new AssistantError(
                "scene_conflict",
                "An added element ID already exists.",
              )
          // Excalidraw assigns null indices on load by bumping versions. Doing
          // this before saving prevents a read-only visit from invalidating undo.
          plan.elements = indexAddedElements(room.elements, plan.elements)
          const validated = parseClientMessage(
            JSON.stringify({
              type: "SCENE_UPDATE",
              payload: { elements: plan.elements },
            }),
          )
          if (!validated)
            throw new AssistantError(
              "invalid_input",
              "The planned elements are invalid.",
            )
          const next = withEdit(room.elements, plan.elements)
          validateSceneSize(next)
          const settings = { ...room.settings }
          const beforeSettings: Partial<SceneSettings> = {}
          const afterSettings: Partial<SceneSettings> = {}
          for (const key of Object.keys(
            input.settings?.patch ?? {},
          ) as (keyof SceneSettings)[]) {
            if (room.settings[key] !== input.settings?.base[key])
              throw new AssistantError(
                "scene_conflict",
                `The drawing setting ${key} changed. Read the scene again.`,
              )
            Object.assign(beforeSettings, { [key]: room.settings[key] })
            Object.assign(afterSettings, { [key]: input.settings?.patch[key] })
            Object.assign(settings, { [key]: input.settings?.patch[key] })
          }
          await requireStoredImages(tx, found.drawingId, plan.elements)
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
          const touched = new Set(plan.elements.map(({ id }) => id))
          const [operation] = await tx
            .insert(assistantOperations)
            .values({
              id: randomUUID(),
              conversationId: conversation.id,
              runId: run.id,
              requestId: input.requestId,
              requestHash: hash,
              summary: input.summary,
              before: room.elements.filter(({ id }) => touched.has(id)),
              after: plan.elements,
              beforeSettings,
              afterSettings,
              sceneRevision: saved.revision,
              createdAt: timestamp,
            })
            .returning()
          await appendEvent(
            tx,
            conversation,
            {
              runId: run.id,
              kind: "scene_committed",
              data: {
                ...eventData(run),
                operationId: operation.id,
                sceneRevision: saved.revision,
              },
            },
            timestamp,
          )
          return { operation, applied: true as const, next, settings }
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

    async listOperations(userId: string, conversationId: string) {
      await findConversation(db, userId, conversationId)
      const rows = await db
        .select({
          id: assistantOperations.id,
          runId: assistantOperations.runId,
          summary: assistantOperations.summary,
          sceneRevision: assistantOperations.sceneRevision,
          createdAt: assistantOperations.createdAt,
          undoOf: assistantOperations.undoOf,
          revertedAt: assistantOperations.revertedAt,
        })
        .from(assistantOperations)
        .where(eq(assistantOperations.conversationId, conversationId))
        .orderBy(desc(assistantOperations.sceneRevision))
        .limit(50)
      return rows.map((row) => ({
        ...row,
        canUndo:
          !row.undoOf &&
          !row.revertedAt &&
          row.createdAt.getTime() >=
            now().getTime() - ASSISTANT_UNDO_RETENTION_MS,
      }))
    },
  }
}
