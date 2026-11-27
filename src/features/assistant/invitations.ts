import { randomBytes, randomUUID } from "node:crypto"
import { and, eq, gt, isNull } from "drizzle-orm"
import { z } from "zod"
import type { Db } from "@/db"
import {
  assistantConversations,
  assistantDrawingGrants,
  assistantRuns,
  drawings,
} from "@/db/schema"
import { hashToken } from "@/features/access-tokens/tokens"
import type { RoomRegistry } from "@/features/collab/room-session"
import {
  requireRoomBarrier,
  withRoomScene,
} from "@/features/collab/room-session"
import { accessibleTo } from "@/features/spaces/access"
import { validCredential } from "./runs"
import { identifier } from "./schemas"
import { AssistantError, LEASE_DURATION_MS, leaseIsLive } from "./state"
import {
  activeRun,
  appendEvent,
  appendMessage,
  eventData,
  findConversation,
  lockConversation,
  requestHash,
  type Tx,
} from "./storage"
import type {
  AssistantRun,
  Clock,
  Conversation,
  WorkerPrincipal,
} from "./types"

const PREFIX = "exs_canvas_"
export const INVITATION_DURATION_MS = 24 * 60 * 60_000
export const barrierInput = z.object({
  connectionId: identifier,
  requestId: identifier,
})
export const invitationInput = z.object({
  conversationId: identifier,
  barrier: barrierInput,
})
export const invitationControlInput = z.object({
  conversationId: identifier,
  grantId: identifier,
  command: z.enum(["pause", "resume", "revoke"]),
  barrier: barrierInput.optional(),
})
export type DrawingCredential = {
  userId: string
  credentialKind: "drawing_grant"
  credentialId: string
  conversationId: string
  drawingId: string
}

/** Checked on every HTTP request, including initialized clients' later calls. */
export async function drawingCredentialForToken(
  db: Db,
  token: string,
  now = new Date(),
): Promise<DrawingCredential | null> {
  if (!token.startsWith(PREFIX)) return null
  const [row] = await db
    .select({
      credentialId: assistantDrawingGrants.id,
      conversationId: assistantConversations.id,
      userId: assistantConversations.userId,
      drawingId: assistantConversations.drawingId,
    })
    .from(assistantDrawingGrants)
    .innerJoin(
      assistantConversations,
      eq(assistantConversations.id, assistantDrawingGrants.conversationId),
    )
    .innerJoin(drawings, eq(drawings.id, assistantConversations.drawingId))
    .where(
      and(
        eq(assistantDrawingGrants.tokenHash, hashToken(token)),
        isNull(assistantDrawingGrants.revokedAt),
        gt(assistantDrawingGrants.expiresAt, now),
        isNull(drawings.deletedAt),
        // The user id is a column here: access must still hold after a move/deletion.
        accessibleTo(drawings, assistantConversations.userId),
      ),
    )
  if (!row) return null
  await db
    .update(assistantDrawingGrants)
    .set({ lastSeenAt: now })
    .where(eq(assistantDrawingGrants.id, row.credentialId))
  return { ...row, credentialKind: "drawing_grant" }
}

async function recordControl(
  tx: Tx,
  conversation: Conversation,
  run: AssistantRun,
  command: "pause" | "resume" | "cancel",
  timestamp: Date,
) {
  const [updated] = await tx
    .update(assistantRuns)
    .set({
      control: command === "resume" ? "running" : "paused",
      controlVersion: run.controlVersion + 1,
      lastInputSequence: conversation.nextMessageSequence,
      ...(command === "cancel" && {
        status: "cancelled" as const,
        finishedAt: timestamp,
        leaseExpiresAt: null,
      }),
      updatedAt: timestamp,
    })
    .where(eq(assistantRuns.id, run.id))
    .returning()
  const message = await appendMessage(
    tx,
    conversation,
    {
      runId: run.id,
      source: "member",
      kind: command,
      body: null,
      requestId: randomUUID(),
      requestHash: requestHash([command, updated.controlVersion]),
    },
    timestamp,
  )
  await appendEvent(
    tx,
    conversation,
    {
      runId: run.id,
      kind: "run_controlled",
      data: eventData(updated, message),
    },
    timestamp,
  )
  return updated
}

export function createInvitationStore(
  db: Db,
  rooms: RoomRegistry,
  now: Clock = () => new Date(),
) {
  return {
    async metadata(userId: string, conversationId: string) {
      await findConversation(db, userId, conversationId)
      const [grant] = await db
        .select({
          id: assistantDrawingGrants.id,
          expiresAt: assistantDrawingGrants.expiresAt,
          lastSeenAt: assistantDrawingGrants.lastSeenAt,
          clientName: assistantDrawingGrants.clientName,
          control: assistantDrawingGrants.control,
        })
        .from(assistantDrawingGrants)
        .where(
          and(
            eq(assistantDrawingGrants.conversationId, conversationId),
            isNull(assistantDrawingGrants.revokedAt),
            gt(assistantDrawingGrants.expiresAt, now()),
          ),
        )
      return grant ?? null
    },

    async create(userId: string, raw: unknown) {
      const input = invitationInput.parse(raw)
      const found = await findConversation(db, userId, input.conversationId)
      return withRoomScene(rooms, found.drawingId, async (room) => {
        requireRoomBarrier(room, userId, input.barrier)
        return db.transaction(async (tx) => {
          const conversation = await lockConversation(
            tx,
            userId,
            input.conversationId,
          )
          const timestamp = now()
          const run = await activeRun(tx, conversation.id)
          if (run)
            await recordControl(tx, conversation, run, "cancel", timestamp)
          if (!room.serverManaged)
            throw new AssistantError(
              "writer_required",
              "Prepare the drawing first.",
            )
          await tx
            .update(assistantDrawingGrants)
            .set({ revokedAt: timestamp })
            .where(
              and(
                eq(assistantDrawingGrants.conversationId, conversation.id),
                isNull(assistantDrawingGrants.revokedAt),
              ),
            )
          const token = `${PREFIX}${randomBytes(32).toString("base64url")}`
          const expiresAt = new Date(
            timestamp.getTime() + INVITATION_DURATION_MS,
          )
          const id = randomUUID()
          await tx.insert(assistantDrawingGrants).values({
            id,
            conversationId: conversation.id,
            tokenHash: hashToken(token),
            createdAt: timestamp,
            expiresAt,
          })
          // Only this response contains the secret. Queries never return the hash or secret.
          return { id, token, expiresAt, drawingId: found.drawingId }
        })
      })
    },

    async control(userId: string, raw: unknown) {
      const input = invitationControlInput.parse(raw)
      const found = await findConversation(db, userId, input.conversationId)
      return withRoomScene(rooms, found.drawingId, async (room) => {
        if (input.command === "resume") {
          if (!input.barrier)
            throw new AssistantError(
              "invalid_input",
              "Synchronize the canvas before handing it back.",
            )
          requireRoomBarrier(room, userId, input.barrier)
        }
        return db.transaction(async (tx) => {
          const conversation = await lockConversation(
            tx,
            userId,
            input.conversationId,
          )
          const run = await activeRun(tx, conversation.id)
          const [grant] = await tx
            .select()
            .from(assistantDrawingGrants)
            .where(
              and(
                eq(assistantDrawingGrants.id, input.grantId),
                eq(assistantDrawingGrants.conversationId, conversation.id),
              ),
            )
            .for("update")
          const timestamp = now()
          if (!grant || grant.revokedAt || grant.expiresAt <= timestamp)
            throw new AssistantError(
              "credential_revoked",
              "This invitation has expired or was closed.",
            )
          const control = input.command === "resume" ? "running" : "paused"
          if (
            run?.source === "invitation" &&
            (run.control !== control || input.command === "revoke")
          )
            await recordControl(
              tx,
              conversation,
              run,
              input.command === "revoke" ? "cancel" : input.command,
              timestamp,
            )
          await tx
            .update(assistantDrawingGrants)
            .set({
              control,
              ...(input.command === "revoke" && { revokedAt: timestamp }),
            })
            .where(eq(assistantDrawingGrants.id, grant.id))
          return { control, revoked: input.command === "revoke" }
        })
      })
    },

    async status(credential: DrawingCredential) {
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          credential.userId,
          credential.conversationId,
        )
        await validCredential(tx, { ...credential, workerId: "status" }, now)
        const [grant] = await tx
          .update(assistantDrawingGrants)
          .set({ lastSeenAt: now() })
          .where(eq(assistantDrawingGrants.id, credential.credentialId))
          .returning()
        const run = await activeRun(tx, conversation.id)
        return {
          drawingId: credential.drawingId,
          expiresAt: grant.expiresAt,
          control: run?.source === "invitation" ? run.control : grant.control,
          controlVersion: run?.controlVersion ?? null,
          instruction:
            "When paused, stop writing. After resume call canvas_read again for a fresh context. An ended AI conversation needs the user's next message; this service cannot wake it.",
        }
      })
    },

    /** A read creates a fresh, credential-bound lease generation; old plans cannot return. */
    async beginRead(
      credential: DrawingCredential,
      clientId: string,
      clientName: string,
    ) {
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          credential.userId,
          credential.conversationId,
        )
        let run = await activeRun(tx, conversation.id)
        const principal: WorkerPrincipal = { ...credential, workerId: clientId }
        const timestamp = await validCredential(tx, principal, now)
        const [grant] = await tx
          .select()
          .from(assistantDrawingGrants)
          .where(eq(assistantDrawingGrants.id, credential.credentialId))
        if (grant.control === "paused" || run?.control === "paused")
          throw new AssistantError(
            "paused",
            "The member is drawing. Wait for resume, then read again.",
          )
        if (
          run &&
          (run.source !== "invitation" ||
            (leaseIsLive(run, timestamp) &&
              (run.workerId !== clientId ||
                run.credentialId !== credential.credentialId)))
        )
          throw new AssistantError(
            "run_busy",
            "Another client holds the drawing. Ask the member to regenerate the invitation to switch clients.",
          )
        if (!run) {
          ;[run] = await tx
            .insert(assistantRuns)
            .values({
              id: randomUUID(),
              conversationId: conversation.id,
              source: "invitation",
              firstInputSequence: conversation.nextMessageSequence,
              lastInputSequence: conversation.nextMessageSequence,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning()
          const message = await appendMessage(
            tx,
            conversation,
            {
              runId: run.id,
              source: "member",
              kind: "resume",
              body: null,
              requestId: randomUUID(),
              requestHash: requestHash(["invitation", grant.id]),
            },
            timestamp,
          )
          await appendEvent(
            tx,
            conversation,
            {
              runId: run.id,
              kind: "run_created",
              data: eventData(run, message),
            },
            timestamp,
          )
        }
        const [claimed] = await tx
          .update(assistantRuns)
          .set({
            status: "running",
            credentialKind: "drawing_grant",
            credentialId: grant.id,
            workerId: clientId,
            workerState: "working",
            leaseGeneration: run.leaseGeneration + 1,
            acknowledgedControlVersion: run.controlVersion,
            receivedThroughSequence: run.lastInputSequence,
            leaseExpiresAt: new Date(timestamp.getTime() + LEASE_DURATION_MS),
            updatedAt: timestamp,
          })
          .where(eq(assistantRuns.id, run.id))
          .returning()
        await tx
          .update(assistantDrawingGrants)
          .set({ lastSeenAt: timestamp, clientName })
          .where(eq(assistantDrawingGrants.id, grant.id))
        await appendEvent(
          tx,
          conversation,
          {
            runId: run.id,
            kind: "run_claimed",
            data: {
              ...eventData(claimed),
              leaseGeneration: claimed.leaseGeneration,
            },
          },
          timestamp,
        )
        return {
          conversationId: conversation.id,
          runId: run.id,
          generation: claimed.leaseGeneration,
          controlVersion: claimed.controlVersion,
        }
      })
    },
  }
}
