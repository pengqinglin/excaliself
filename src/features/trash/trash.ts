// Trash engines behind Move to trash, for the app and the MCP tools. Kept out
// of the server function modules, which import the live db, like restore.ts.
// The caller ends the trashed drawings' Rooms.

import { and, eq, inArray, isNull } from "drizzle-orm"
import type { Db } from "@/db"
import { drawings, folders } from "@/db/schema"
import { cancelDrawingRuns } from "@/features/assistant/lifecycle"
import { collectFolderSubtreeIds } from "@/features/folders/subtree"
import { lockFolderTree } from "@/features/folders/tree-lock"
import { accessibleTo } from "@/features/spaces/access"

/** Soft-deletes one drawing. The row keeps its folderId, so restore is in place. */
export async function trashDrawingUnit(
  db: Db,
  userId: string,
  id: string,
): Promise<void> {
  // Leaves updatedAt alone: trashing is not an edit and must not reshuffle
  // recency-ordered lists once the drawing is restored.
  await db.transaction(async (tx) => {
    const timestamp = new Date()
    const trashed = await tx
      .update(drawings)
      .set({ deletedAt: timestamp, trashRootId: id, deletedBy: userId })
      .where(
        and(
          eq(drawings.id, id),
          accessibleTo(drawings, userId),
          isNull(drawings.deletedAt),
        ),
      )
      .returning({ id: drawings.id })
    if (trashed.length === 0) throw new Error("Drawing not found")
    await cancelDrawingRuns(tx, [id], timestamp)
  })
}

/**
 * Soft-deletes a folder and its whole subtree (descendant folders + their
 * drawings) as one trash unit: every swept row gets the same trashRootId so
 * the unit can be restored intact. Rows that were already trashed keep their
 * own unit and are left untouched — restoring this folder must not resurrect
 * things trashed separately before it. Returns the swept drawing ids.
 */
export async function trashFolderUnit(
  db: Db,
  userId: string,
  id: string,
): Promise<string[]> {
  const now = new Date()
  const swept = await db.transaction(async (tx) => {
    await lockFolderTree(tx, "change")
    const liveFolders = await tx
      .select({ id: folders.id, parentId: folders.parentId })
      .from(folders)
      .where(and(accessibleTo(folders, userId), isNull(folders.deletedAt)))
    if (!liveFolders.some((folder) => folder.id === id))
      throw new Error("Folder not found")

    const subtreeIds = [...collectFolderSubtreeIds(liveFolders, id)]

    await tx
      .update(folders)
      .set({ deletedAt: now, trashRootId: id, deletedBy: userId })
      .where(
        and(
          inArray(folders.id, subtreeIds),
          accessibleTo(folders, userId),
          isNull(folders.deletedAt),
        ),
      )
    // Leaves updatedAt alone (see trashDrawingUnit) so restore is in place.
    const trashed = await tx
      .update(drawings)
      .set({ deletedAt: now, trashRootId: id, deletedBy: userId })
      .where(
        and(
          inArray(drawings.folderId, subtreeIds),
          accessibleTo(drawings, userId),
          isNull(drawings.deletedAt),
        ),
      )
      .returning({ id: drawings.id })
    await cancelDrawingRuns(
      tx,
      trashed.map((row) => row.id),
      now,
    )
    return trashed
  })
  return swept.map((drawing) => drawing.id)
}
