import { and, eq, isNotNull } from "drizzle-orm"
import type { Db } from "@/db"
import {
  accessTokens,
  assistantEvents,
  assistantMessages,
  assistantRuns,
  oauthGrants,
} from "@/db/schema"
import {
  acknowledgementInput,
  controlInput,
  leaseInput,
  pageInput,
  parseInput,
  principalInput,
  reportInput,
} from "./schemas"
import {
  AssistantError,
  isTerminal,
  LEASE_DURATION_MS,
  leaseIsLive,
} from "./state"
import {
  appendEvent,
  appendMessage,
  assertSameRequest,
  eventData,
  findRun,
  lockConversation,
  lockRun,
  messagePage,
  previousMemberMessage,
  requestHash,
  type Tx,
} from "./storage"
import type { AssistantRun, Clock, RunLease, WorkerPrincipal } from "./types"

const workInput = pageInput.extend({ runId: leaseInput.shape.runId })

/** Share-locking the credential fences deletion/refresh against this transaction. */
export async function validCredential(
  tx: Tx,
  principal: WorkerPrincipal,
  now: Clock,
) {
  if (principal.credentialKind === "access_token") {
    const [token] = await tx
      .select({ id: accessTokens.id })
      .from(accessTokens)
      .where(
        and(
          eq(accessTokens.id, principal.credentialId),
          eq(accessTokens.userId, principal.userId),
        ),
      )
      .for("share")
    if (token) return now()
  } else {
    const [grant] = await tx
      .select({ expiresAt: oauthGrants.accessTokenExpiresAt })
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.id, principal.credentialId),
          eq(oauthGrants.userId, principal.userId),
          isNotNull(oauthGrants.accessTokenHash),
        ),
      )
      .for("share")
    const timestamp = now()
    if (grant?.expiresAt && grant.expiresAt > timestamp) return timestamp
  }
  throw new AssistantError(
    "credential_revoked",
    "The worker credential is no longer valid.",
  )
}

function sameWorker(run: AssistantRun, principal: WorkerPrincipal) {
  return (
    run.workerId === principal.workerId &&
    run.credentialKind === principal.credentialKind &&
    run.credentialId === principal.credentialId
  )
}

export function assertLease(
  run: AssistantRun,
  principal: WorkerPrincipal,
  lease: RunLease,
  timestamp: Date,
) {
  if (isTerminal(run.status))
    throw new AssistantError(
      "invalid_transition",
      "The task has already ended.",
    )
  if (
    !sameWorker(run, principal) ||
    run.leaseGeneration !== lease.generation ||
    !leaseIsLive(run, timestamp)
  )
    throw new AssistantError(
      "lease_lost",
      "The worker no longer holds this task's lease.",
    )
}

/** Use only after locking and reading the current task in a write transaction. */
export function assertCurrentWork(run: AssistantRun, controlVersion: number) {
  if (run.controlVersion !== controlVersion)
    throw new AssistantError(
      "stale_control",
      "Read the latest task instructions before continuing.",
    )
  if (run.control === "paused")
    throw new AssistantError("paused", "The task is paused.")
  if (
    run.acknowledgedControlVersion !== run.controlVersion ||
    run.receivedThroughSequence < run.lastInputSequence
  )
    throw new AssistantError(
      "input_unacknowledged",
      "Acknowledge the latest instructions first.",
    )
  if (run.status !== "running")
    throw new AssistantError(
      "invalid_transition",
      "The task is waiting for a member's reply.",
    )
}

const leaseDeadline = (now: Date) => new Date(now.getTime() + LEASE_DURATION_MS)

export function createRunStore(db: Db, now: Clock) {
  return {
    async controlRun(userId: string, raw: unknown) {
      const input = parseInput(controlInput, raw)
      const hash = requestHash({
        kind: input.command,
        runId: input.runId,
        version: input.expectedControlVersion,
      })
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
        let run = await lockRun(tx, conversation.id, input.runId)
        if (isTerminal(run.status))
          throw new AssistantError(
            "invalid_transition",
            "The task has already ended.",
          )
        if (run.controlVersion !== input.expectedControlVersion)
          throw new AssistantError(
            "stale_control",
            "The task changed. Read its current state first.",
          )
        const timestamp = now()
        const control = input.command === "resume" ? "running" : "paused"
        const cancelled = input.command === "cancel"
        ;[run] = await tx
          .update(assistantRuns)
          .set({
            control,
            controlVersion:
              run.controlVersion +
              (cancelled || control !== run.control ? 1 : 0),
            lastInputSequence: conversation.nextMessageSequence,
            ...(cancelled && {
              status: "cancelled",
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
            kind: input.command,
            body: null,
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
            kind: "run_controlled",
            data: eventData(run, message),
          },
          timestamp,
        )
        return { message, run }
      })
    },

    async claimRun(rawPrincipal: WorkerPrincipal, raw: unknown) {
      const principal = parseInput(principalInput, rawPrincipal)
      const input = parseInput(
        workInput.pick({ conversationId: true, runId: true }),
        raw,
      )
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          principal.userId,
          input.conversationId,
        )
        const run = await lockRun(tx, conversation.id, input.runId)
        const timestamp = await validCredential(tx, principal, now)
        if (isTerminal(run.status))
          throw new AssistantError(
            "invalid_transition",
            "The task has already ended.",
          )
        if (leaseIsLive(run, timestamp)) {
          if (sameWorker(run, principal)) return run
          throw new AssistantError(
            "run_busy",
            "Another worker holds this task's lease.",
          )
        }
        const [claimed] = await tx
          .update(assistantRuns)
          .set({
            status: run.status === "queued" ? "running" : run.status,
            credentialKind: principal.credentialKind,
            credentialId: principal.credentialId,
            workerId: principal.workerId,
            workerState: "working",
            leaseGeneration: run.leaseGeneration + 1,
            leaseExpiresAt: leaseDeadline(timestamp),
            acknowledgedControlVersion: 0,
            updatedAt: timestamp,
          })
          .where(eq(assistantRuns.id, run.id))
          .returning()
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
        return claimed
      })
    },

    async getWork(rawPrincipal: WorkerPrincipal, raw: unknown) {
      const principal = parseInput(principalInput, rawPrincipal)
      const input = parseInput(workInput, raw)
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          principal.userId,
          input.conversationId,
          false,
        )
        const run = await lockRun(tx, conversation.id, input.runId)
        await validCredential(tx, principal, now)
        // Expired/terminal workers may read the state to learn that they must stop.
        if (!sameWorker(run, principal))
          throw new AssistantError(
            "lease_lost",
            "This task belongs to another worker.",
          )
        return {
          run,
          messages: await messagePage(
            tx,
            conversation.id,
            input.afterSequence,
            input.limit,
          ),
        }
      })
    },

    async renewLease(rawPrincipal: WorkerPrincipal, raw: unknown) {
      const principal = parseInput(principalInput, rawPrincipal)
      const input = parseInput(leaseInput, raw)
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          principal.userId,
          input.conversationId,
        )
        const run = await lockRun(tx, conversation.id, input.runId)
        const timestamp = await validCredential(tx, principal, now)
        assertLease(run, principal, input, timestamp)
        const [renewed] = await tx
          .update(assistantRuns)
          .set({
            leaseExpiresAt: leaseDeadline(timestamp),
            updatedAt: timestamp,
          })
          .where(eq(assistantRuns.id, run.id))
          .returning()
        return renewed
      })
    },

    async acknowledgeRun(rawPrincipal: WorkerPrincipal, raw: unknown) {
      const principal = parseInput(principalInput, rawPrincipal)
      const input = parseInput(acknowledgementInput, raw)
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          principal.userId,
          input.conversationId,
        )
        const run = await lockRun(tx, conversation.id, input.runId)
        const timestamp = await validCredential(tx, principal, now)
        assertLease(run, principal, input, timestamp)
        if (run.controlVersion !== input.controlVersion)
          throw new AssistantError(
            "stale_control",
            "Read the latest task instructions before acknowledging.",
          )
        if (
          input.throughSequence < run.lastInputSequence ||
          input.throughSequence < run.receivedThroughSequence ||
          input.throughSequence >= conversation.nextMessageSequence
        )
          throw new AssistantError(
            "invalid_input",
            "The received-message position is outside the current input range.",
          )
        if (
          run.acknowledgedControlVersion === input.controlVersion &&
          run.receivedThroughSequence === input.throughSequence
        )
          return run
        const [acknowledged] = await tx
          .update(assistantRuns)
          .set({
            acknowledgedControlVersion: input.controlVersion,
            receivedThroughSequence: input.throughSequence,
            workerState:
              run.control === "paused"
                ? "paused"
                : run.status === "awaiting_input"
                  ? "awaiting_input"
                  : "working",
            leaseExpiresAt: leaseDeadline(timestamp),
            updatedAt: timestamp,
          })
          .where(eq(assistantRuns.id, run.id))
          .returning()
        await appendEvent(
          tx,
          conversation,
          {
            runId: run.id,
            kind: "run_acknowledged",
            data: {
              ...eventData(acknowledged),
              throughSequence: input.throughSequence,
            },
          },
          timestamp,
        )
        return acknowledged
      })
    },

    async reportRun(rawPrincipal: WorkerPrincipal, raw: unknown) {
      const principal = parseInput(principalInput, rawPrincipal)
      const input = parseInput(reportInput, raw)
      const key = `worker:${requestHash([input.runId, input.generation, input.requestId])}`
      // A replacement credential for the same member may recover a committed
      // report. New reports still require the exact credential-bound lease.
      const hash = requestHash([
        { userId: principal.userId, workerId: principal.workerId },
        input,
      ])
      return db.transaction(async (tx) => {
        const conversation = await lockConversation(
          tx,
          principal.userId,
          input.conversationId,
        )
        const run = await lockRun(tx, conversation.id, input.runId)
        const timestamp = await validCredential(tx, principal, now)
        const [previous] = await tx
          .select()
          .from(assistantEvents)
          .where(
            and(
              eq(assistantEvents.conversationId, conversation.id),
              eq(assistantEvents.requestId, key),
            ),
          )
        if (previous) {
          assertSameRequest(previous.requestHash, hash)
          const [message] = await tx
            .select()
            .from(assistantMessages)
            .where(
              and(
                eq(assistantMessages.conversationId, conversation.id),
                eq(assistantMessages.id, previous.data.messageId ?? ""),
              ),
            )
          return { event: previous, message }
        }
        assertLease(run, principal, input, timestamp)
        assertCurrentWork(run, input.controlVersion)
        const terminal = input.kind === "completed" || input.kind === "failed"
        const [reported] = await tx
          .update(assistantRuns)
          .set({
            status: input.kind === "progress" ? "running" : input.kind,
            workerState:
              input.kind === "awaiting_input" ? "awaiting_input" : "working",
            leaseExpiresAt: terminal ? null : leaseDeadline(timestamp),
            finishedAt: terminal ? timestamp : null,
            updatedAt: timestamp,
          })
          .where(eq(assistantRuns.id, run.id))
          .returning()
        const message = await appendMessage(
          tx,
          conversation,
          {
            runId: run.id,
            source: "worker",
            kind: "assistant",
            body: input.body,
            requestId: key,
            requestHash: hash,
          },
          timestamp,
        )
        const event = await appendEvent(
          tx,
          conversation,
          {
            runId: run.id,
            kind: "run_reported",
            data: { ...eventData(reported, message), reportKind: input.kind },
            requestId: key,
            requestHash: hash,
          },
          timestamp,
        )
        return { event, message }
      })
    },
  }
}
