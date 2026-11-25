import type { AssistantRun, RunStatus } from "./types"

export const LEASE_DURATION_MS = 60_000

export type AssistantErrorCode =
  | "not_found"
  | "invalid_input"
  | "idempotency_conflict"
  | "invalid_transition"
  | "run_busy"
  | "lease_lost"
  | "stale_control"
  | "paused"
  | "input_unacknowledged"
  | "credential_revoked"
  | "scene_conflict"
  | "writer_required"
  | "scene_unreadable"

export class AssistantError extends Error {
  constructor(
    public readonly code: AssistantErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "AssistantError"
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

export function leaseIsLive(
  run: Pick<AssistantRun, "leaseExpiresAt">,
  now: Date,
): boolean {
  return run.leaseExpiresAt !== null && run.leaseExpiresAt > now
}
