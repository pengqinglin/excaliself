import type {
  assistantConversations,
  assistantEvents,
  assistantMessages,
  assistantRuns,
} from "@/db/schema"

export const runStatuses = [
  "queued",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
] as const
export const runControls = ["running", "paused"] as const
export const workerStates = ["working", "paused", "awaiting_input"] as const
export const credentialKinds = [
  "access_token",
  "oauth_grant",
  "drawing_grant",
] as const
export const messageKinds = [
  "user",
  "assistant",
  "pause",
  "resume",
  "cancel",
] as const
export const reportKinds = [
  "progress",
  "awaiting_input",
  "completed",
  "failed",
] as const
export const eventKinds = [
  "message_created",
  "run_created",
  "run_claimed",
  "run_controlled",
  "run_acknowledged",
  "run_reported",
  "scene_committed",
] as const

export type RunStatus = (typeof runStatuses)[number]
export type RunControl = (typeof runControls)[number]
export type WorkerState = (typeof workerStates)[number]
export type ReportKind = (typeof reportKinds)[number]
export type CredentialKind = (typeof credentialKinds)[number]

/** Constructed by authenticated transport code, never from a member's form. */
export type WorkerPrincipal = {
  userId: string
  credentialKind: CredentialKind
  credentialId: string
  workerId: string
}

/** A new claim fences every request carrying an older generation. */
export type RunLease = {
  conversationId: string
  runId: string
  generation: number
}

export type Conversation = typeof assistantConversations.$inferSelect
export type AssistantRun = typeof assistantRuns.$inferSelect
export type AssistantMessage = typeof assistantMessages.$inferSelect
export type AssistantEvent = typeof assistantEvents.$inferSelect

/** Public event data contains references and state, never credentials or reasoning. */
export type EventData = {
  status: RunStatus
  control: RunControl
  controlVersion: number
  messageId?: string
  messageSequence?: number
  leaseGeneration?: number
  throughSequence?: number
  reportKind?: ReportKind
  operationId?: string
  sceneRevision?: number
  undoOf?: string
  reason?: "drawing_trashed"
}

export type Page<T> = {
  items: T[]
  /** Last returned sequence, suitable as the next exclusive cursor. */
  nextCursor: number
  hasMore: boolean
}

export type Clock = () => Date
