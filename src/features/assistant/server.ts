"use server"

import { createServerFn } from "@tanstack/react-start"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { drawings } from "@/db/schema"
import { rooms } from "@/features/collab/room-registry"
import { listUpdates } from "@/features/list-updates/hub"
import { authMiddleware } from "@/middleware/auth"
import { createAssistantRevertStore, revertInput } from "./revert"
import { createAssistantSceneStore } from "./scene"
import {
  controlInput,
  conversationInput,
  drawingInput,
  historyInput,
  instructionInput,
  pageInput,
} from "./schemas"
import { AssistantError } from "./state"
import { findConversation } from "./storage"
import { createAssistantStore } from "./store"
import { createAssistantWorkerStore } from "./workers"

const assistant = createAssistantStore(db)

export const getAssistantConnections = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) =>
    createAssistantWorkerStore(db).connections(context.session.user.id),
  )

export const openAssistantConversation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(drawingInput)
  .handler(({ context, data }) =>
    assistant.getOrCreateConversation(context.session.user.id, data),
  )

export const getAssistantConversation = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(conversationInput)
  .handler(({ context, data }) =>
    assistant.getConversation(context.session.user.id, data),
  )

export const getAssistantMessages = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(pageInput)
  .handler(({ context, data }) =>
    assistant.listMessages(context.session.user.id, data),
  )

export const getAssistantHistory = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(historyInput)
  .handler(({ context, data }) =>
    assistant.recentMessages(context.session.user.id, data),
  )

export const getAssistantPanelState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(conversationInput)
  .handler(async ({ context, data }) => {
    const userId = context.session.user.id
    const [state, operations, connections] = await Promise.all([
      assistant.getConversation(userId, data),
      createAssistantSceneStore(db, rooms).listOperations(
        userId,
        data.conversationId,
      ),
      createAssistantWorkerStore(db).connections(userId),
    ])
    return { ...state, operations, connections }
  })

export const getAssistantEvents = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(pageInput)
  .handler(({ context, data }) =>
    assistant.listEvents(context.session.user.id, data),
  )

export const sendAssistantMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(instructionInput)
  .handler(async ({ context, data }) => {
    const userId = context.session.user.id
    const conversation = await findConversation(db, userId, data.conversationId)
    const [drawing] = await db
      .select({ serverManagedAt: drawings.serverManagedAt })
      .from(drawings)
      .where(eq(drawings.id, conversation.drawingId))
    if (!drawing?.serverManagedAt)
      throw new AssistantError(
        "writer_required",
        "Prepare this drawing before starting an assistant task.",
      )
    return assistant.sendInstruction(userId, data)
  })

export const controlAssistantRun = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(controlInput)
  .handler(({ context, data }) =>
    assistant.controlRun(context.session.user.id, data),
  )

export const revertAssistantOperation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(revertInput)
  .handler(async ({ context, data }) => {
    try {
      const result = await createAssistantRevertStore(
        db,
        rooms,
      ).revertOperation(context.session.user.id, data)
      if (!result.replayed) listUpdates.notify()
      return result
    } catch (error) {
      if (error instanceof AssistantError && error.code === "scene_conflict")
        return { status: "conflict" as const }
      throw error
    }
  })
