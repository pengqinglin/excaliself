// What a Room loads on spin-up and writes back.

import { and, eq, gte, lt, notInArray, sql } from "drizzle-orm"
import type { Db } from "@/db"
import {
  assistantConversations,
  assistantOperations,
  drawingFiles,
  drawings,
} from "@/db/schema"
import { ASSISTANT_UNDO_RETENTION_MS } from "@/features/assistant/limits"
import { referencedFileIds } from "@/features/drawings/scene-write"
import { sceneText } from "@/features/drawings/search"
import type { AccessRow } from "@/features/spaces/access"
import type { SceneElement } from "./protocol"
import { type SceneSettings, storedSceneSettings } from "./scene-settings"
import { DELETED_ELEMENT_TIMEOUT_MS } from "./scene-sync"

/** The stored scene plus what the live badge's access check needs. */
export type StoredScene = {
  elements: SceneElement[]
  /** Null when the drawing is gone. */
  access: AccessRow | null
  /** False when the stored JSON could not be read. */
  readable: boolean
  serverManaged?: boolean
  settings?: SceneSettings
}

/** Lenient like `restore()`: our own data, so defaults beat dropping elements. */
export function toRoomElements(value: unknown): SceneElement[] {
  if (!Array.isArray(value)) return []
  const elements: SceneElement[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      continue
    const element = entry as Record<string, unknown>
    if (typeof element.id !== "string" || !element.id) continue
    elements.push({
      ...element,
      id: element.id,
      version: typeof element.version === "number" ? element.version : 1,
      versionNonce:
        typeof element.versionNonce === "number" ? element.versionNonce : 0,
    })
  }
  return elements
}

/** Null when unreadable; a blank drawing is `{}`. */
function parseStoredObject(
  data: string | null | undefined,
): Record<string, unknown> | null {
  if (!data) return {}
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Unreadable JSON comes back empty with `readable: false`, so no Room opens
 * on it and that emptiness never overwrites the file.
 */
export function parseStoredScene(data: string | null | undefined): {
  elements: SceneElement[]
  readable: boolean
} {
  const stored = parseStoredObject(data)
  if (!stored) return { elements: [], readable: false }
  return { elements: toRoomElements(stored.elements), readable: true }
}

export async function loadRoomScene(
  db: Db,
  drawingId: string,
): Promise<StoredScene> {
  const [drawing] = await db
    .select({
      data: drawings.data,
      space: drawings.space,
      createdBy: drawings.createdBy,
      serverManagedAt: drawings.serverManagedAt,
    })
    .from(drawings)
    .where(eq(drawings.id, drawingId))
  return {
    ...parseStoredScene(drawing?.data),
    serverManaged: drawing?.serverManagedAt != null,
    settings: storedSceneSettings(parseStoredObject(drawing?.data)?.appState),
    access: drawing
      ? { space: drawing.space, createdBy: drawing.createdBy }
      : null,
  }
}

/** Replaces only `elements`; `appState` and the envelope stay as last saved. */
export function mergeSceneElements(
  data: string | null | undefined,
  elements: SceneElement[],
  settings?: SceneSettings,
): string {
  const stored = parseStoredObject(data) ?? {}
  const state =
    stored.appState && typeof stored.appState === "object"
      ? stored.appState
      : {}
  return JSON.stringify({
    ...stored,
    elements,
    ...(settings && { appState: { ...state, ...settings } }),
  })
}

/** An upload can land before its image's scene update, so new rows are kept this long. */
export const FILE_GRACE_MS = 60 * 60 * 1000

/**
 * Writes a Room's scene, bumps `updatedAt` and drops images nothing uses. Not
 * guarded on `deletedAt`, so a trash mid-session keeps guest work for a restore.
 */
export async function saveRoomScene(
  db: Db,
  drawingId: string,
  elements: SceneElement[],
  settings?: SceneSettings,
  requireImages = false,
): Promise<void> {
  const now = Date.now()
  await db.transaction(async (tx) => {
    const [drawing] = await tx
      .select({ data: drawings.data })
      .from(drawings)
      .where(eq(drawings.id, drawingId))
      .for("update")
    if (!drawing) {
      if (requireImages) throw new Error("Drawing not found")
      return
    }
    if (requireImages) {
      const files = await tx
        .select({ id: drawingFiles.fileId })
        .from(drawingFiles)
        .where(eq(drawingFiles.drawingId, drawingId))
      const stored = new Set(files.map(({ id }) => id))
      if ([...referencedFileIds(elements)].some((id) => !stored.has(id)))
        throw new Error("Scene images have not finished uploading")
    }
    await tx
      .update(drawings)
      .set({
        data: mergeSceneElements(drawing.data, elements, settings),
        sceneRevision: sql`${drawings.sceneRevision} + 1`,
        searchText: sceneText(elements),
        updatedAt: new Date(now),
      })
      .where(eq(drawings.id, drawingId))

    // Undo brings a deleted image back as "saved" and nothing re-uploads it,
    // so recent tombstones keep their bytes.
    const used = referencedFileIds(elements, now - DELETED_ELEMENT_TIMEOUT_MS)
    await tx.delete(drawingFiles).where(
      and(
        eq(drawingFiles.drawingId, drawingId),
        lt(drawingFiles.createdAt, new Date(now - FILE_GRACE_MS)),
        notInArray(drawingFiles.fileId, [...used]),
        sql`not exists (
            select 1 from ${assistantOperations}
            inner join ${assistantConversations} on ${assistantConversations.id} = ${assistantOperations.conversationId}
            where ${and(eq(assistantConversations.drawingId, drawingId), gte(assistantOperations.createdAt, new Date(now - ASSISTANT_UNDO_RETENTION_MS)))}
            and exists (select 1 from jsonb_array_elements(${assistantOperations.before}) as entry(value)
              where entry.value->>'type' = 'image' and entry.value->>'fileId' = ${drawingFiles.fileId}
              and coalesce(entry.value->>'isDeleted', 'false') <> 'true')
          )`,
      ),
    )
  })
}
