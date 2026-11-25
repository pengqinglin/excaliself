import type { McpServer } from "@modelcontextprotocol/server"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { Db } from "@/db"
import { assistantOperations } from "@/db/schema"
import type { RoomRegistry } from "@/features/collab/room-session"
import { listUpdates } from "@/features/list-updates/hub"
import { SceneInputError } from "@/features/mcp/scene/skeleton"
import { validCredential } from "./runs"
import {
  commitEditInput,
  createAssistantSceneStore,
  operationReceipt,
  sceneWorkInput,
} from "./scene"
import {
  acknowledgementInput,
  identifier,
  leaseInput,
  pageInput,
  reportInput,
  runInput,
} from "./schemas"
import { AssistantError } from "./state"
import { findConversation } from "./storage"
import { createAssistantStore } from "./store"
import type { WorkerPrincipal } from "./types"
import { createAssistantWorkerStore } from "./workers"

type Credential = Pick<
  WorkerPrincipal,
  "userId" | "credentialKind" | "credentialId"
>
const json = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  ...(isError && { isError: true }),
})

export function registerAssistantTools(
  server: McpServer,
  db: Db,
  credential: Credential,
  rooms: RoomRegistry,
) {
  const store = createAssistantStore(db)
  const scenes = createAssistantSceneStore(db, rooms)
  const workers = createAssistantWorkerStore(db)
  const worker = z.object({ workerId: identifier })
  const principal = (workerId: string): WorkerPrincipal => ({
    ...credential,
    workerId,
  })
  function tool<T extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: z.ZodObject<T>,
    action: (input: z.output<z.ZodObject<T>>) => Promise<unknown>,
    readOnly = false,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (input) => {
        try {
          return json(await action(input as z.output<z.ZodObject<T>>))
        } catch (error) {
          const code =
            error instanceof AssistantError
              ? error.code
              : error instanceof SceneInputError || error instanceof z.ZodError
                ? "invalid_input"
                : "internal_error"
          const message =
            code === "internal_error"
              ? "The request could not be completed. Read the current state before retrying."
              : (error as Error).message
          return json({ error: { code, message } }, true)
        }
      },
    )
  }

  tool(
    "assistant_poll",
    "Keep the Codex connector online and discover this member's durable drawing tasks. Does not claim a task. Poll every 2–5 seconds while idle.",
    worker.extend({ name: z.string().min(1).max(100).default("Codex") }),
    async ({ workerId, name }) => ({
      protocolVersion: 1,
      memberId: credential.userId,
      tasks: await workers.poll(principal(workerId), name),
    }),
  )
  tool(
    "assistant_claim",
    "Claim one task or recover this worker's current lease. Use the returned leaseGeneration on all subsequent writes. Another live worker's task is busy.",
    runInput.extend(worker.shape),
    ({ workerId, ...input }) => store.claimRun(principal(workerId), input),
  )
  tool(
    "assistant_work",
    "Read current controls and private messages in sequence. Read every page before acknowledging through the latest input. Stop active work if paused, cancelled, changed or the lease is lost.",
    pageInput.extend({ runId: identifier, ...worker.shape }),
    ({ workerId, ...input }) => store.getWork(principal(workerId), input),
    true,
  )
  tool(
    "assistant_heartbeat",
    "Renew a task lease independently of model execution, at least every 20 seconds. This does not acknowledge new instructions.",
    leaseInput.extend(worker.shape),
    ({ workerId, ...input }) => store.renewLease(principal(workerId), input),
  )
  tool(
    "assistant_acknowledge",
    "Confirm receiving all current instructions or the pause/resume control. A stale control version is rejected. Acknowledge only after reading all required messages.",
    acknowledgementInput.extend(worker.shape),
    ({ workerId, ...input }) =>
      store.acknowledgeRun(principal(workerId), input),
  )
  tool(
    "assistant_report",
    "Persist a concise progress update, a question (awaiting_input), a final answer (completed) or a failure. Completion is a model result; only scene operation receipts prove drawing edits were saved. Reuse requestId when retrying.",
    reportInput.extend(worker.shape),
    ({ workerId, ...input }) => store.reportRun(principal(workerId), input),
  )
  tool(
    "assistant_read_scene",
    "Read this task's current authoritative drawing, revision map, settings and description. Use its base revisions for assistant_commit_edit. Requires a live acknowledged running lease.",
    sceneWorkInput.extend(worker.shape),
    ({ workerId, ...input }) => scenes.readScene(principal(workerId), input),
    true,
  )
  tool(
    "assistant_commit_edit",
    "Apply and durably save this task's drawing edit. add/change/remove use edit_drawing's element format; base must include every affected existing element and bound label/connector from assistant_read_scene. Settings compare only patched fields. Unrelated human edits survive; scene_conflict requires rereading. Do not use ordinary edit_drawing for task edits. Reuse requestId for the exact same retry; saved returns a durable operation ID.",
    commitEditInput.extend(worker.shape),
    async ({ workerId, ...input }) => {
      const receipt = await scenes.commitEdit(principal(workerId), input)
      if (!receipt.replayed) listUpdates.notify()
      return receipt
    },
  )
  tool(
    "assistant_get_operation",
    "Recover a durable scene receipt by its requestId even after losing a lease. Null means no committed operation exists for that request. Never infer saved from a natural-language answer.",
    z.object({
      conversationId: identifier,
      requestId: identifier,
      ...worker.shape,
    }),
    async ({ workerId, conversationId, requestId }) => {
      await findConversation(db, credential.userId, conversationId)
      return db.transaction(async (tx) => {
        await validCredential(tx, principal(workerId), () => new Date())
        const [operation] = await tx
          .select()
          .from(assistantOperations)
          .where(
            and(
              eq(assistantOperations.conversationId, conversationId),
              eq(assistantOperations.requestId, requestId),
            ),
          )
        return operation ? operationReceipt(operation) : null
      })
    },
    true,
  )
}
