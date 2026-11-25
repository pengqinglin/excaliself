import { and, eq, inArray, sql } from "drizzle-orm"
import type { Db } from "@/db"
import {
  assistantConversations,
  assistantRuns,
  assistantWorkers,
} from "@/db/schema"
import { appendEvent, eventData, type Tx } from "./storage"
import type { CredentialKind } from "./types"

/** The caller already holds the affected drawing locks, inside its trash transaction. */
export async function cancelDrawingRuns(
  tx: Tx,
  drawingIds: string[],
  timestamp: Date,
) {
  if (!drawingIds.length) return
  const conversations = await tx
    .select()
    .from(assistantConversations)
    .where(inArray(assistantConversations.drawingId, drawingIds))
    .orderBy(assistantConversations.id)
    .for("update")
  for (const conversation of conversations) {
    const cancelled = await tx
      .update(assistantRuns)
      .set({
        status: "cancelled",
        control: "paused",
        controlVersion: sql`${assistantRuns.controlVersion} + 1`,
        leaseExpiresAt: null,
        finishedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(assistantRuns.conversationId, conversation.id),
          inArray(assistantRuns.status, [
            "queued",
            "running",
            "awaiting_input",
          ]),
        ),
      )
      .returning()
    for (const run of cancelled)
      await appendEvent(
        tx,
        conversation,
        {
          runId: run.id,
          kind: "run_controlled",
          data: { ...eventData(run), reason: "drawing_trashed" },
        },
        timestamp,
      )
  }
}

/** Run AFTER credential deletion commits, avoiding credential→run lock inversion. */
export async function releaseCredentialWork(
  db: Db,
  kind: CredentialKind,
  id: string,
) {
  const matches = and(
    eq(assistantRuns.credentialKind, kind),
    eq(assistantRuns.credentialId, id),
    inArray(assistantRuns.status, ["queued", "running", "awaiting_input"]),
  )
  await db
    .update(assistantRuns)
    .set({
      leaseExpiresAt: new Date(0),
      acknowledgedControlVersion: 0,
      status: sql`case when ${assistantRuns.status} = 'running' then 'queued' else ${assistantRuns.status} end`,
      updatedAt: new Date(),
    })
    .where(matches)
  await db
    .delete(assistantWorkers)
    .where(
      and(
        eq(assistantWorkers.credentialKind, kind),
        eq(assistantWorkers.credentialId, id),
      ),
    )
}
