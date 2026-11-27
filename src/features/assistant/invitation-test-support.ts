import { randomUUID } from "node:crypto"
import type { Db } from "@/db"
import type { ServerMessage } from "@/features/collab/protocol"
import {
  createRoomRegistry,
  joinRoom,
  type RoomPeer,
  receiveFromPeer,
} from "@/features/collab/room-session"
import { loadRoomScene, saveRoomScene } from "@/features/collab/scene-store"
import { activateServerWriter } from "@/features/drawings/writer-mode"
import { createInvitationStore, drawingCredentialForToken } from "./invitations"
import { createAssistantSceneStore } from "./scene"
import { createAssistantStore } from "./store"
import { seedAssistantTest } from "./test-support"
import type { Clock } from "./types"

export const invitationShape = (id: string) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  version: 1,
  versionNonce: 1,
})

export async function invitationFixture(db: Db, now: Clock = () => new Date()) {
  const seed = await seedAssistantTest(db)
  await activateServerWriter(db, seed.ownerId, {
    id: seed.drawingId,
    expectedRevision: 0,
    snapshot: {
      data: JSON.stringify({ elements: [invitationShape("original")] }),
      files: [],
    },
  })
  const rooms = createRoomRegistry(
    (id) => loadRoomScene(db, id),
    (id, elements, settings, strict) =>
      saveRoomScene(db, id, elements, settings, strict),
  )
  const store = createAssistantStore(db, now)
  const conversation = await store.getOrCreateConversation(seed.ownerId, {
    drawingId: seed.drawingId,
  })
  const messages: ServerMessage[] = []
  const peer: RoomPeer = {
    id: randomUUID(),
    bufferedAmount: 0,
    send: (message) => messages.push(message),
    publish: () => {},
    subscribe: () => {},
    close: () => {},
  }
  await joinRoom(rooms, seed.drawingId, peer, {
    userId: seed.ownerId,
    sessionId: "test-session",
    displayName: "Owner",
    image: null,
  })
  const frame = (type: string, payload: unknown) =>
    receiveFromPeer(
      rooms,
      seed.drawingId,
      peer,
      JSON.stringify({ type, payload }),
    )
  const sync = async () => {
    const requestId = randomUUID()
    await frame("SCENE_SYNC", { requestId })
    return { connectionId: peer.id, requestId }
  }
  const invitations = createInvitationStore(db, rooms, now)
  const grant = await invitations.create(seed.ownerId, {
    conversationId: conversation.id,
    barrier: await sync(),
  })
  const credential = await drawingCredentialForToken(db, grant.token, now())
  if (!credential) throw new Error("Test invitation not created")
  return {
    ...seed,
    rooms,
    store,
    conversation,
    messages,
    peer,
    frame,
    sync,
    invitations,
    grant,
    credential,
    scenes: createAssistantSceneStore(db, rooms, now),
    worker: { ...credential, workerId: "direct-client" },
    read: () => invitations.beginRead(credential, "direct-client", "Test AI"),
  }
}
