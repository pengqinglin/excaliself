import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm"
import type { Db } from "@/db"
import {
  accessTokens,
  assistantConversations,
  assistantRuns,
  assistantWorkers,
  drawings,
  oauthGrants,
} from "@/db/schema"
import { accessibleTo } from "@/features/spaces/access"
import { validCredential } from "./runs"
import { parseInput, principalInput } from "./schemas"
import type { Clock, WorkerPrincipal } from "./types"

export const WORKER_ONLINE_MS = 45_000

export function createAssistantWorkerStore(
  db: Db,
  now: Clock = () => new Date(),
) {
  return {
    async poll(rawPrincipal: WorkerPrincipal, name = "Codex") {
      const principal = parseInput(principalInput, rawPrincipal)
      return db.transaction(async (tx) => {
        const timestamp = await validCredential(tx, principal, now)
        await tx
          .delete(assistantWorkers)
          .where(
            lt(
              assistantWorkers.lastSeenAt,
              new Date(timestamp.getTime() - 30 * 24 * 60 * 60_000),
            ),
          )
        await tx
          .insert(assistantWorkers)
          .values({
            ...principal,
            name: name.trim().slice(0, 100) || "Codex",
            lastSeenAt: timestamp,
          })
          .onConflictDoUpdate({
            target: [
              assistantWorkers.userId,
              assistantWorkers.credentialKind,
              assistantWorkers.credentialId,
              assistantWorkers.workerId,
            ],
            set: {
              lastSeenAt: timestamp,
              name: name.trim().slice(0, 100) || "Codex",
            },
          })
        return tx
          .select({
            conversationId: assistantConversations.id,
            drawingId: drawings.id,
            run: assistantRuns,
          })
          .from(assistantRuns)
          .innerJoin(
            assistantConversations,
            eq(assistantRuns.conversationId, assistantConversations.id),
          )
          .innerJoin(
            drawings,
            eq(assistantConversations.drawingId, drawings.id),
          )
          .where(
            and(
              eq(assistantConversations.userId, principal.userId),
              eq(assistantRuns.source, "connector"),
              accessibleTo(drawings, principal.userId),
              isNull(drawings.deletedAt),
              isNotNull(drawings.serverManagedAt),
              inArray(assistantRuns.status, [
                "queued",
                "running",
                "awaiting_input",
              ]),
              or(
                isNull(assistantRuns.leaseExpiresAt),
                lte(assistantRuns.leaseExpiresAt, timestamp),
                and(
                  eq(assistantRuns.workerId, principal.workerId),
                  eq(assistantRuns.credentialKind, principal.credentialKind),
                  eq(assistantRuns.credentialId, principal.credentialId),
                ),
              ),
            ),
          )
          .orderBy(asc(assistantRuns.createdAt))
          .limit(20)
      })
    },

    /** Only the member sees their own connection status, with credentials omitted. */
    async connections(userId: string) {
      const timestamp = now()
      return db
        .select({
          workerId: assistantWorkers.workerId,
          name: assistantWorkers.name,
          lastSeenAt: assistantWorkers.lastSeenAt,
        })
        .from(assistantWorkers)
        .leftJoin(
          accessTokens,
          and(
            eq(assistantWorkers.credentialKind, "access_token"),
            eq(assistantWorkers.credentialId, accessTokens.id),
            eq(accessTokens.userId, userId),
          ),
        )
        .leftJoin(
          oauthGrants,
          and(
            eq(assistantWorkers.credentialKind, "oauth_grant"),
            eq(assistantWorkers.credentialId, oauthGrants.id),
            eq(oauthGrants.userId, userId),
          ),
        )
        .where(
          and(
            eq(assistantWorkers.userId, userId),
            gt(
              assistantWorkers.lastSeenAt,
              new Date(timestamp.getTime() - WORKER_ONLINE_MS),
            ),
            or(
              isNotNull(accessTokens.id),
              and(
                isNotNull(oauthGrants.accessTokenHash),
                gt(oauthGrants.accessTokenExpiresAt, timestamp),
              ),
            ),
          ),
        )
    },
  }
}
