import { and, eq, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import type { Db } from "@/db"
import { drawings, shares } from "@/db/schema"
import { parseClientMessage } from "@/features/collab/protocol"
import {
  MAX_ROOM_ELEMENTS,
  MAX_ROOM_SCENE_BYTES,
} from "@/features/collab/room-session"
import { accessibleTo } from "@/features/spaces/access"
import { writeDrawingSceneInTransaction } from "./scene-write"

export const activateWriterInput = z.object({
  id: z.string().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  // Omit for a drawing already owned by a Room. Never write that tab's snapshot.
  snapshot: z
    .object({
      data: z.string().max(MAX_ROOM_SCENE_BYTES),
      files: z.array(z.object({ fileId: z.string(), dataUrl: z.string() })),
    })
    .optional(),
})

export type WriterActivation =
  | { status: "activated"; serverManagedAt: Date; sceneRevision: number }
  | { status: "conflict"; sceneRevision: number }

/** Final solo snapshot and promotion commit together. Share permissions stay independent. */
export async function activateServerWriter(
  db: Db,
  userId: string,
  raw: unknown,
): Promise<WriterActivation> {
  const input = activateWriterInput.parse(raw)
  return db.transaction(async (tx) => {
    const [drawing] = await tx
      .select({
        space: drawings.space,
        serverManagedAt: drawings.serverManagedAt,
        sceneRevision: drawings.sceneRevision,
      })
      .from(drawings)
      .where(
        and(
          eq(drawings.id, input.id),
          accessibleTo(drawings, userId),
          isNull(drawings.deletedAt),
        ),
      )
      .for("update")
    if (!drawing) throw new Error("Drawing not found")
    if (drawing.serverManagedAt)
      return {
        status: "activated",
        serverManagedAt: drawing.serverManagedAt,
        sceneRevision: drawing.sceneRevision,
      }
    const [share] = await tx
      .select({ id: shares.id })
      .from(shares)
      .where(eq(shares.drawingId, input.id))
    if (drawing.space === "private" && !share) {
      if (drawing.sceneRevision !== input.expectedRevision)
        return { status: "conflict", sceneRevision: drawing.sceneRevision }
      if (!input.snapshot) throw new Error("A final scene snapshot is required")
      let scene: unknown
      try {
        scene = JSON.parse(input.snapshot.data)
      } catch {
        throw new Error("Scene unreadable")
      }
      if (!scene || typeof scene !== "object" || Array.isArray(scene))
        throw new Error("Scene unreadable")
      const elements = "elements" in scene ? scene.elements : []
      const validated = parseClientMessage(
        JSON.stringify({ type: "SCENE_UPDATE", payload: { elements } }),
      )
      if (
        !validated ||
        !Array.isArray(elements) ||
        elements.length > MAX_ROOM_ELEMENTS ||
        Buffer.byteLength(input.snapshot.data) > MAX_ROOM_SCENE_BYTES
      )
        throw new Error("Scene is invalid or exceeds the collaboration limit")
      const saved = await writeDrawingSceneInTransaction(tx, userId, {
        id: input.id,
        ...input.snapshot,
      })
      if (saved.status !== "saved") throw new Error("Drawing writer changed")
      if (saved.missingFileIds.length || saved.overCapFileIds.length)
        throw new Error("All scene images must be stored before the handoff")
    }
    const [promoted] = await tx
      .update(drawings)
      .set({
        serverManagedAt: new Date(),
        sceneRevision: sql`${drawings.sceneRevision} + 1`,
      })
      .where(eq(drawings.id, input.id))
      .returning({
        serverManagedAt: drawings.serverManagedAt,
        sceneRevision: drawings.sceneRevision,
      })
    // serverManagedAt was assigned by this statement.
    return {
      status: "activated",
      serverManagedAt: promoted.serverManagedAt as Date,
      sceneRevision: promoted.sceneRevision,
    }
  })
}
