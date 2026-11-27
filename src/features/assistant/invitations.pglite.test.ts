// @vitest-environment node
import { createMcpHandler } from "@modelcontextprotocol/server"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import type { Db } from "@/db"
import { assistantDrawingGrants, drawings } from "@/db/schema"
import {
  closeAllRooms,
  type RoomRegistry,
} from "@/features/collab/room-session"
import { loadRoomScene } from "@/features/collab/scene-store"
import { CANVAS_TOOLS, createInvitationMcpServer } from "./invitation-mcp"
import { invitationFixture, invitationShape } from "./invitation-test-support"
import { drawingCredentialForToken } from "./invitations"
import { createAssistantTestDb } from "./test-support"
import { createAssistantWorkerStore } from "./workers"

let db: Db
let close: () => Promise<void>
const registries: RoomRegistry[] = []
beforeAll(async () => {
  ;({ db, close } = await createAssistantTestDb())
}, 30_000)
afterEach(async () => {
  await Promise.all(registries.splice(0).map(closeAllRooms))
})
afterAll(async () => close?.())
async function setup(now?: () => Date) {
  const value = await invitationFixture(db, now)
  registries.push(value.rooms)
  return value
}

test("invitation stores only a hash; metadata never exposes credentials; it expires and rotates", async () => {
  let time = new Date()
  const s = await setup(() => time)
  const [stored] = await db
    .select()
    .from(assistantDrawingGrants)
    .where(eq(assistantDrawingGrants.id, s.grant.id))
  expect(stored.tokenHash).toHaveLength(64)
  expect(JSON.stringify(stored)).not.toContain(s.grant.token)
  expect(
    await s.invitations.metadata(s.ownerId, s.conversation.id),
  ).not.toHaveProperty("tokenHash")
  time = new Date(time.getTime() + 24 * 60 * 60_000)
  expect(await drawingCredentialForToken(db, s.grant.token, time)).toBeNull()
  await expect(s.read()).rejects.toMatchObject({ code: "credential_revoked" })
  const replacement = await s.invitations.create(s.ownerId, {
    conversationId: s.conversation.id,
    barrier: await s.sync(),
  })
  expect(replacement.token).not.toBe(s.grant.token)
  expect(await drawingCredentialForToken(db, s.grant.token, time)).toBeNull()
  expect(
    await drawingCredentialForToken(db, replacement.token, time),
  ).not.toBeNull()
})

test("direct clients need no local instruction; read establishes a fresh lease and ordinary connectors cannot claim it", async () => {
  const s = await setup()
  const context = await s.read()
  const snapshot = await s.scenes.readScene(s.worker, context)
  expect(snapshot.elements.map(({ id }) => id)).toEqual(["original"])
  expect(await createAssistantWorkerStore(db).poll(s.principal)).toEqual([])
  await expect(s.store.claimRun(s.principal, context)).rejects.toMatchObject({
    code: "not_found",
  })
  await expect(
    s.invitations.beginRead(s.credential, "competitor", "Other AI"),
  ).rejects.toMatchObject({ code: "run_busy" })
  const fresh = await s.read()
  expect(fresh.generation).toBe(context.generation + 1)
  await expect(
    s.scenes.commitEdit(s.worker, {
      ...context,
      requestId: "old-read",
      summary: "Stale plan",
      base: {},
      add: [{ type: "rectangle" }],
    }),
  ).rejects.toMatchObject({ code: "lease_lost" })
})

test("pause fences late saves, resume requires durable browser sync and old contexts never revive", async () => {
  const s = await setup()
  const context = await s.read()
  const edit = {
    ...context,
    requestId: "late",
    summary: "Old plan",
    base: {},
    add: [{ type: "rectangle" }],
  }
  const control = { conversationId: s.conversation.id, grantId: s.grant.id }
  await s.invitations.control(s.ownerId, { ...control, command: "pause" })
  await expect(s.scenes.commitEdit(s.worker, edit)).rejects.toMatchObject({
    code: "stale_control",
  })
  await expect(s.read()).rejects.toMatchObject({ code: "paused" })
  // Queue the last human stroke and barrier together, without waiting for a trailing flush.
  const stroke = s.frame("SCENE_UPDATE", {
    elements: [invitationShape("last-human-stroke")],
  })
  const synced = s.sync()
  await stroke
  const barrier = await synced
  await expect(
    s.invitations.control(s.ownerId, { ...control, command: "resume" }),
  ).rejects.toMatchObject({ code: "invalid_input" })
  await s.invitations.control(s.ownerId, {
    ...control,
    command: "resume",
    barrier,
  })
  await expect(s.scenes.commitEdit(s.worker, edit)).rejects.toMatchObject({
    code: "stale_control",
  })
  const fresh = await s.read()
  expect(
    (await s.scenes.readScene(s.worker, fresh)).elements.map(({ id }) => id),
  ).toContain("last-human-stroke")
  expect(
    (await loadRoomScene(db, s.drawingId)).elements.map(({ id }) => id),
  ).toContain("last-human-stroke")
})

test("direct commits use existing durable receipts, deduplication, conflict protection and scoped lease checks", async () => {
  const s = await setup()
  const context = await s.read()
  const scene = await s.scenes.readScene(s.worker, context)
  const input = {
    ...context,
    requestId: "save",
    summary: "Move original",
    base: scene.base,
    change: [{ id: "original", x: 200 }],
  }
  const receipt = await s.scenes.commitEdit(s.worker, input)
  expect(receipt.status).toBe("saved")
  expect(await s.scenes.commitEdit(s.worker, input)).toMatchObject({
    id: receipt.id,
    replayed: true,
  })
  await s.frame("SCENE_UPDATE", {
    elements: [
      { ...invitationShape("original"), version: 20, x: 400 },
      invitationShape("unrelated"),
    ],
  })
  await expect(
    s.scenes.commitEdit(s.worker, { ...input, requestId: "conflict" }),
  ).rejects.toMatchObject({ code: "scene_conflict" })
  const other = await s.store.getOrCreateConversation(s.ownerId, {
    drawingId: s.teamId,
  })
  const { run } = await s.store.sendInstruction(s.ownerId, {
    conversationId: other.id,
    requestId: "other-task",
    body: "Private instruction must not leak",
  })
  await expect(
    s.scenes.commitEdit(s.worker, {
      ...input,
      conversationId: other.id,
      runId: run.id,
    }),
  ).rejects.toMatchObject({ code: "lease_lost" })
})

test("revocation, rotation and current drawing access invalidate credentials and existing work", async () => {
  const s = await setup()
  const context = await s.read()
  await s.invitations.control(s.ownerId, {
    conversationId: s.conversation.id,
    grantId: s.grant.id,
    command: "revoke",
  })
  expect(await drawingCredentialForToken(db, s.grant.token)).toBeNull()
  await expect(s.scenes.readScene(s.worker, context)).rejects.toMatchObject({
    code: "credential_revoked",
  })
  const replacement = await s.invitations.create(s.ownerId, {
    conversationId: s.conversation.id,
    barrier: await s.sync(),
  })
  await db
    .update(drawings)
    .set({ createdBy: s.otherId })
    .where(eq(drawings.id, s.drawingId))
  expect(await drawingCredentialForToken(db, replacement.token)).toBeNull()
})

test("a failed durable sync or missing image never authorizes a handoff", async () => {
  const s = await setup()
  await s.frame("SCENE_UPDATE", {
    elements: [
      { ...invitationShape("image"), type: "image", fileId: "missing" },
    ],
  })
  const barrier = await s.sync()
  expect(s.messages.at(-1)).toMatchObject({
    type: "SCENE_SYNCED",
    payload: { saved: false },
  })
  await expect(
    s.invitations.create(s.ownerId, {
      conversationId: s.conversation.id,
      barrier,
    }),
  ).rejects.toThrow("Synchronize")
})

test("the MCP server exposes exactly scoped canvas tools, no member chat or account tools", async () => {
  const s = await setup()
  const handler = createMcpHandler(() =>
    createInvitationMcpServer(db, s.credential, s.rooms),
  )
  let id = 0
  const rpc = async (method: string, params: unknown) => {
    const response = await handler.fetch(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
    )
    const body = await response.text()
    const data = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? JSON.parse(
          body
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5) ?? "{}",
        )
      : JSON.parse(body)
    return data
  }
  const listed = await rpc("tools/list", {})
  expect(
    listed.result.tools.map((tool: { name: string }) => tool.name).sort(),
  ).toEqual([...CANVAS_TOOLS].sort())
  expect(
    (await rpc("tools/call", { name: "list_drawings", arguments: {} })).error,
  ).toBeDefined()
  const read = await rpc("tools/call", {
    name: "canvas_read",
    arguments: { clientId: "mcp-client" },
  })
  const scene = JSON.parse(read.result.content[0].text)
  const committed = await rpc("tools/call", {
    name: "canvas_commit",
    arguments: {
      clientId: "mcp-client",
      context: scene.context,
      edit: {
        requestId: "mcp-save",
        summary: "Extend original",
        base: scene.base,
        add: [{ type: "rectangle", x: 200, y: 0, label: "AI" }],
      },
    },
  })
  expect(JSON.parse(committed.result.content[0].text)).toMatchObject({
    status: "saved",
  })
  const wrong = await rpc("tools/call", {
    name: "canvas_commit",
    arguments: {
      clientId: "mcp-client",
      context: { ...scene.context, conversationId: "another" },
      edit: {
        requestId: "wrong",
        summary: "No",
        base: {},
        add: [{ type: "rectangle" }],
      },
    },
  })
  expect(JSON.parse(wrong.result.content[0].text)).toMatchObject({
    error: { code: "not_found" },
  })
})
