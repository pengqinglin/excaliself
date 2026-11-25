import type { Db } from "@/db"
import { createConversationStore } from "./conversations"
import { createRunStore } from "./runs"
import type { Clock } from "./types"

/** All durable state lives in Db; recreating this service loses no work. */
export function createAssistantStore(db: Db, now: Clock = () => new Date()) {
  return { ...createConversationStore(db, now), ...createRunStore(db, now) }
}
