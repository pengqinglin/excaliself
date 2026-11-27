import { McpServer } from "@modelcontextprotocol/server"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { Db } from "@/db"
import { assistantOperations } from "@/db/schema"
import type { RoomRegistry } from "@/features/collab/room-session"
import { listUpdates } from "@/features/list-updates/hub"
import { SceneInputError } from "@/features/mcp/scene/skeleton"
import { createInvitationStore, type DrawingCredential } from "./invitations"
import { assertCurrentWork, validCredential } from "./runs"
import {
  commitEditInput,
  createAssistantSceneStore,
  operationReceipt,
  sceneWorkInput,
} from "./scene"
import { identifier } from "./schemas"
import { AssistantError } from "./state"
import { lockConversation } from "./storage"
import { createAssistantStore } from "./store"

export const CANVAS_TOOLS = [
  "canvas_status",
  "canvas_read",
  "canvas_heartbeat",
  "canvas_commit",
  "canvas_get_operation",
  "canvas_finish",
] as const

/** Separate server: drawing credentials never register account-level or private-chat tools. */
export function createInvitationMcpServer(
  db: Db,
  credential: DrawingCredential,
  rooms: RoomRegistry,
) {
  const server = new McpServer(
    { name: "excaliself-canvas", version: "1.0.0" },
    {
      instructions:
        "This credential authorizes exactly one drawing. Call canvas_read before planning any edit. Use the returned context and base revisions. Renew the lease every 20 seconds while working. Pause/revocation fences all new writes. After resume or any conflict read again. Only a saved operation receipt proves persistence. Use canvas_finish when done; it does not prove scene edits were saved.",
    },
  )
  const invitations = createInvitationStore(db, rooms)
  const scenes = createAssistantSceneStore(db, rooms)
  const store = createAssistantStore(db)
  const principal = (clientId: string) => ({
    ...credential,
    workerId: clientId,
  })
  const work = z.object({ clientId: identifier, context: sceneWorkInput })
  const scope = (context: z.infer<typeof sceneWorkInput>) => {
    if (context.conversationId !== credential.conversationId)
      throw new AssistantError(
        "not_found",
        "This credential only authorizes its invited drawing.",
      )
  }
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
          idempotentHint:
            name === "canvas_commit" || name === "canvas_get_operation",
        },
      },
      async (input) => {
        try {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  await action(input as z.output<z.ZodObject<T>>),
                ),
              },
            ],
          }
        } catch (error) {
          const code =
            error instanceof AssistantError
              ? error.code
              : error instanceof SceneInputError || error instanceof z.ZodError
                ? "invalid_input"
                : "internal_error"
          const message =
            code === "internal_error"
              ? "Read the current state before retrying."
              : (error as Error).message
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: { code, message } }),
              },
            ],
          }
        }
      },
    )
  }
  tool(
    "canvas_status",
    "Read this drawing's control and invitation expiry. Poll while waiting; paused means stop writing. No messages or other drawings are exposed.",
    z.object({}),
    () => invitations.status(credential),
    true,
  )
  tool(
    "canvas_read",
    "Read the authoritative scene, settings, base revisions and saved receipts. Choose a stable unique clientId for this conversation. Every read issues a fresh work context and invalidates the preceding generation. After resume, conflict or lease expiry read again. No web chat task is needed.",
    z.object({
      clientId: identifier,
      clientName: z.string().trim().min(1).max(100).default("External AI"),
    }),
    async ({ clientId, clientName }) => {
      const context = await invitations.beginRead(
        credential,
        clientId,
        clientName,
      )
      return {
        context,
        leaseSeconds: 60,
        ...(await scenes.readScene(principal(clientId), context)),
      }
    },
  )
  tool(
    "canvas_heartbeat",
    "Renew the current 60-second lease at least every 20 seconds during model work. Stop on paused/stale_control/lease_lost and reread after resume.",
    work,
    async ({ clientId, context }) => {
      scope(context)
      const run = await store.renewLease(principal(clientId), context)
      assertCurrentWork(run, context.controlVersion)
      return { leaseExpiresAt: run.leaseExpiresAt }
    },
  )
  tool(
    "canvas_commit",
    "Directly apply and durably save changes to this drawing. Preserve unrelated content. base must include every affected existing element and bound label/connector from canvas_read. change/remove use element IDs; add uses Excaliself skeletons. On scene_conflict read again. Reuse requestId only for an identical retry; saved returns a durable operation ID. The member can undo it with the existing conflict rules.",
    work.extend({
      edit: commitEditInput.omit({
        conversationId: true,
        runId: true,
        generation: true,
        controlVersion: true,
      }),
    }),
    async ({ clientId, context, edit }) => {
      scope(context)
      const receipt = await scenes.commitEdit(principal(clientId), {
        ...edit,
        ...context,
      })
      if (!receipt.replayed) listUpdates.notify()
      return receipt
    },
  )
  tool(
    "canvas_get_operation",
    "Recover a durable receipt by requestId, even after losing a lease. null means no committed operation exists. Never infer saved from heartbeat or a model answer.",
    z.object({ requestId: identifier }),
    ({ requestId }) =>
      db.transaction(async (tx) => {
        await lockConversation(tx, credential.userId, credential.conversationId)
        await validCredential(tx, principal("receipt"), () => new Date())
        const [operation] = await tx
          .select()
          .from(assistantOperations)
          .where(
            and(
              eq(assistantOperations.conversationId, credential.conversationId),
              eq(assistantOperations.requestId, requestId),
            ),
          )
        return operation ? operationReceipt(operation) : null
      }),
    true,
  )
  tool(
    "canvas_finish",
    "Mark this AI turn completed. Only canvas_commit receipts establish saved edits. Next turn starts with canvas_read. A finished external conversation needs the user to say continue after handing back control.",
    work.extend({
      requestId: identifier,
      summary: z.string().trim().min(1).max(10_000),
    }),
    async ({ clientId, context, requestId, summary }) => {
      scope(context)
      await store.reportRun(principal(clientId), {
        ...context,
        requestId,
        body: summary,
        kind: "completed",
      })
      return { status: "completed" }
    },
  )
  return server
}
