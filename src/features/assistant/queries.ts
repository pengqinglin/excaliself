import { queryOptions } from "@tanstack/react-query"
import { getAssistantPanelState, openAssistantConversation } from "./server"

export const assistantKey = (memberId: string, drawingId: string) =>
  ["assistant", memberId, drawingId] as const
export const assistantConversationOptions = (
  memberId: string,
  drawingId: string,
) =>
  queryOptions({
    queryKey: [...assistantKey(memberId, drawingId), "conversation"],
    queryFn: () => openAssistantConversation({ data: { drawingId } }),
    staleTime: Number.POSITIVE_INFINITY,
  })
export const assistantPanelOptions = (
  memberId: string,
  drawingId: string,
  conversationId: string,
) =>
  queryOptions({
    queryKey: [...assistantKey(memberId, drawingId), "state", conversationId],
    queryFn: () => getAssistantPanelState({ data: { conversationId } }),
  })
