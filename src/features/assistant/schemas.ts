import { z } from "zod"
import { AssistantError } from "./state"
import { credentialKinds, reportKinds } from "./types"

export const MAX_MESSAGE_LENGTH = 10_000
export const MAX_PAGE_SIZE = 100
const MAX_SEQUENCE = 2_147_483_646

// PostgreSQL text/jsonb cannot store U+0000. Reject it before opening a transaction.
const postgresText = z.string().refine((value) => !value.includes("\u0000"), {
  error: "Text cannot contain a null character.",
})
export const identifier = postgresText.trim().min(1).max(128)
export const sequence = z.number().int().min(0).max(MAX_SEQUENCE)
export const version = z.number().int().min(1).max(MAX_SEQUENCE)
export const messageBody = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MESSAGE_LENGTH * 2)
  .refine((value) => !value.includes("\u0000"), {
    error: "Messages cannot contain a null character.",
  })
  .refine((value) => [...value].length <= MAX_MESSAGE_LENGTH, {
    error: `Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`,
  })

export const conversationInput = z.object({ conversationId: identifier })
export const drawingInput = z.object({ drawingId: identifier })
export const pageInput = conversationInput.extend({
  afterSequence: sequence.default(0),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
})
export const historyInput = conversationInput.extend({
  beforeSequence: version.optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
})
export const instructionInput = conversationInput.extend({
  requestId: identifier,
  body: messageBody,
})
export const controlInput = conversationInput.extend({
  runId: identifier,
  requestId: identifier,
  command: z.enum(["pause", "resume", "cancel"]),
  expectedControlVersion: version,
})
export const principalInput = z.object({
  userId: identifier,
  credentialKind: z.enum(credentialKinds),
  credentialId: identifier,
  workerId: identifier,
})
export const runInput = conversationInput.extend({ runId: identifier })
export const leaseInput = runInput.extend({ generation: version })
export const acknowledgementInput = leaseInput.extend({
  controlVersion: version,
  throughSequence: sequence,
})
export const reportInput = leaseInput.extend({
  requestId: identifier,
  controlVersion: version,
  kind: z.enum(reportKinds),
  body: messageBody,
})

/** Services validate too: MCP and server functions share the same contract. */
export function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success)
    throw new AssistantError("invalid_input", parsed.error.issues[0].message)
  return parsed.data
}
