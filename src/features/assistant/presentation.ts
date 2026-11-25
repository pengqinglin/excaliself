import type { AssistantRun } from "./types"

export function assistantPhase(
  run: AssistantRun | null | undefined,
  online: boolean,
) {
  if (!run) return "idle"
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  )
    return run.status
  if (run.control === "paused")
    return run.workerId &&
      run.workerState === "working" &&
      run.leaseExpiresAt &&
      new Date(run.leaseExpiresAt).getTime() > Date.now() &&
      run.acknowledgedControlVersion < run.controlVersion
      ? "pausing"
      : "paused"
  if (run.status === "awaiting_input") return "awaiting_input"
  if (!online && run.workerId) return "offline"
  if (run.status === "queued" || !run.workerId) return "queued"
  if (
    run.receivedThroughSequence < run.lastInputSequence ||
    run.acknowledgedControlVersion < run.controlVersion
  )
    return "receiving"
  return "working"
}
