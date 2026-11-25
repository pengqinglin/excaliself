import type { LibraryItem } from "@excalidraw/excalidraw/types"
import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  credentialKinds,
  type EventData,
  eventKinds,
  messageKinds,
  runControls,
  runStatuses,
  workerStates,
} from "../features/assistant/types"
import type { SceneElement } from "../features/collab/protocol"
import type { SceneSettings } from "../features/collab/scene-settings"

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").default(false),
  // "" when unset. better-auth's cookie cache rejects a null name.
  name: text("name").notNull(),
  image: text("image"),
  role: text("role", { enum: ["admin", "user"] })
    .notNull()
    .default("user"),
  createdAt: timestamp("createdAt")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updatedAt")
    .notNull()
    .$defaultFn(() => new Date()),
})

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  createdAt: timestamp("createdAt")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updatedAt")
    .notNull()
    .$defaultFn(() => new Date()),
})

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  idToken: text("idToken"),
  createdAt: timestamp("createdAt")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updatedAt")
    .notNull()
    .$defaultFn(() => new Date()),
})

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updatedAt")
    .notNull()
    .$defaultFn(() => new Date()),
})

export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  invitedBy: text("invitedBy")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  usedBy: text("usedBy").references(() => users.id, { onDelete: "set null" }),
  usedAt: timestamp("usedAt"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt")
    .notNull()
    .$defaultFn(() => new Date()),
})

// Personal access tokens: what a member's AI client signs in to the MCP
// endpoint with. Only a hash is kept; the token itself is shown once.
export const accessTokens = pgTable("access_tokens", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("tokenHash").notNull().unique(),
  // The token's first characters, so a member can tell tokens apart.
  start: text("start").notNull(),
  lastUsedAt: timestamp("lastUsedAt"),
  createdAt: timestamp("createdAt")
    .notNull()
    .$defaultFn(() => new Date()),
})

// OAuth clients an MCP client such as Claude.ai registered for itself
// (Dynamic Client Registration). All public: PKCE stands in for a secret.
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirectUris").$type<string[]>().notNull(),
  createdAt: timestamp("createdAt")
    .notNull()
    .$defaultFn(() => new Date()),
})

// One member's consent to one OAuth client. It holds a one-time code until
// the client trades it for tokens, then the current access and refresh token.
// Only hashes are kept. Deleting the row (or the member) ends the grant.
export const oauthGrants = pgTable("oauth_grants", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  clientId: text("clientId")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  redirectUri: text("redirectUri").notNull(),
  codeHash: text("codeHash").unique(),
  codeChallenge: text("codeChallenge").notNull(),
  codeExpiresAt: timestamp("codeExpiresAt").notNull(),
  accessTokenHash: text("accessTokenHash").unique(),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenHash: text("refreshTokenHash").unique(),
  lastUsedAt: timestamp("lastUsedAt"),
  createdAt: timestamp("createdAt")
    .notNull()
    .$defaultFn(() => new Date()),
})

// Admin-generated password-reset links (issue #68) — the product's only
// reset flow, shared out-of-band. Same single-use token model as invites,
// but targeted at a user and short-lived (24 h).
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBy: text("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    usedAt: timestamp("usedAt"),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    // At most one unused reset per user, enforced by the database — the
    // upsert in createPasswordReset targets this index so concurrent
    // generations serialize instead of leaving two live links.
    onePendingPerUser: uniqueIndex("password_resets_one_pending_per_user")
      .on(table.userId)
      .where(sql`${table.usedAt} is null`),
  }),
)

// Where a drawing or folder lives: its creator's Private space or the shared
// Team space. Who may see a row is decided in features/spaces/access.ts.
export const spaces = ["private", "team"] as const
export type Space = (typeof spaces)[number]

export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    space: text("space", { enum: spaces }).notNull().default("private"),
    // Null once the creator is deleted; only Team rows outlive them.
    createdBy: text("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    parentId: text("parentId"),
    // The Excalidraw+ collection this folder was imported from, so a second
    // import reuses it.
    excalidrawPlusId: text("excalidrawPlusId"),
    // Soft delete: set means "in trash". trashRootId records the trash unit —
    // the id of the folder/drawing whose trashing swept this row along — so a
    // whole subtree can be restored as one unit while each row's trashed
    // state stays individually knowable.
    deletedAt: timestamp("deletedAt"),
    trashRootId: text("trashRootId"),
    deletedBy: text("deletedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    parentReference: foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
    }).onDelete("cascade"),
    creatorUnlessTeam: check(
      "folders_creator_unless_team",
      sql`${table.space} = 'team' OR ${table.createdBy} IS NOT NULL`,
    ),
  }),
)

export const drawings = pgTable(
  "drawings",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    data: text("data").notNull().default("{}"),
    // Monotonic promotion: a Room owns this scene even without a share or seats.
    serverManagedAt: timestamp("serverManagedAt"),
    sceneRevision: integer("sceneRevision").notNull().default(0),
    // The scene's text, derived on every write so lists can search without
    // shipping scenes.
    searchText: text("searchText").notNull().default(""),
    folderId: text("folderId").references(() => folders.id, {
      onDelete: "cascade",
    }),
    // The Excalidraw+ scene this drawing was imported from, so a second
    // import skips it.
    excalidrawPlusId: text("excalidrawPlusId"),
    space: text("space", { enum: spaces }).notNull().default("private"),
    // See folders.createdBy.
    createdBy: text("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    // Soft delete — see folders.deletedAt/trashRootId for the model.
    deletedAt: timestamp("deletedAt"),
    trashRootId: text("trashRootId"),
    deletedBy: text("deletedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    creatorUnlessTeam: check(
      "drawings_creator_unless_team",
      sql`${table.space} = 'team' OR ${table.createdBy} IS NOT NULL`,
    ),
    nonnegativeRevision: check(
      "drawings_scene_revision",
      sql`${table.sceneRevision} >= 0`,
    ),
  }),
)

// Per-member stars; a row means "starred by this member".
export const stars = pgTable(
  "stars",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    drawingId: text("drawingId")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.drawingId] }),
  }),
)

// A drawing is shared iff it has a row here; at most one link per drawing.
export const shares = pgTable(
  "shares",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    drawingId: text("drawingId")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    audience: text("audience", { enum: ["members", "anyone"] })
      .notNull()
      .default("members"),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    oneLinkPerDrawing: uniqueIndex("shares_one_link_per_drawing").on(
      table.drawingId,
    ),
  }),
)

// A members link dropped by a move to Team. Not a share: it only sends
// signed-in members on to the drawing.
export const shareRedirects = pgTable("share_redirects", {
  token: text("token").primaryKey(),
  drawingId: text("drawingId")
    .notNull()
    .references(() => drawings.id, { onDelete: "cascade" }),
})

// node-postgres reads bytea as a Buffer, PGlite as a plain Uint8Array; wrap
// the latter (no copy) so callers always get a Buffer.
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) =>
    Buffer.from(value.buffer, value.byteOffset, value.byteLength),
})

export const drawingFiles = pgTable(
  "drawing_files",
  {
    id: text("id").primaryKey(),
    drawingId: text("drawingId")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    fileId: text("fileId").notNull(),
    mimeType: text("mimeType").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    oneRowPerFile: uniqueIndex("drawing_files_one_row_per_file").on(
      table.drawingId,
      table.fileId,
    ),
  }),
)

// The team library: the Library panel's items, one set for the instance.
// `item` is Excalidraw's LibraryItem as is; newest (highest seq) first.
export const libraryItems = pgTable("library_items", {
  id: text("id").primaryKey(),
  item: jsonb("item").$type<LibraryItem>().notNull(),
  seq: integer("seq").generatedAlwaysAsIdentity().notNull(),
})

// A comment thread pinned to one spot on a drawing. Never part of the scene.
// The pin sits at (x, y), or, with elementId set, at (offsetX, offsetY) as a
// fraction of that element's box; (x, y) is then where it was made.
export const commentThreads = pgTable(
  "comment_threads",
  {
    id: text("id").primaryKey(),
    drawingId: text("drawingId")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    createdBy: text("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    elementId: text("elementId"),
    offsetX: doublePrecision("offsetX"),
    offsetY: doublePrecision("offsetY"),
    resolvedAt: timestamp("resolvedAt"),
    resolvedBy: text("resolvedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
    lastActivityAt: timestamp("lastActivityAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    byDrawing: index("comment_threads_drawing").on(table.drawingId),
    elementAnchor: check(
      "comment_threads_element_anchor",
      sql`(${table.elementId} is null) = (${table.offsetX} is null) and (${table.elementId} is null) = (${table.offsetY} is null)`,
    ),
  }),
)

// One message in a thread. A thread's first comment opens it.
export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(),
    threadId: text("threadId")
      .notNull()
      .references(() => commentThreads.id, { onDelete: "cascade" }),
    authorId: text("authorId").references(() => users.id, {
      onDelete: "set null",
    }),
    // The AI client's name when written over MCP.
    via: text("via"),
    body: text("body").notNull(),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
    editedAt: timestamp("editedAt"),
  },
  (table) => ({
    byThread: index("comments_thread").on(table.threadId, table.createdAt),
  }),
)

// When a member last opened a thread, for its unread dot.
export const commentReads = pgTable(
  "comment_reads",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: text("threadId")
      .notNull()
      .references(() => commentThreads.id, { onDelete: "cascade" }),
    readAt: timestamp("readAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.threadId] }),
  }),
)

// Private member/drawing conversations, independent of scene data and comments.
export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    drawingId: text("drawingId")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    nextMessageSequence: integer("nextMessageSequence").notNull().default(1),
    nextEventSequence: integer("nextEventSequence").notNull().default(1),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    memberDrawing: uniqueIndex("assistant_conversations_member_drawing").on(
      table.userId,
      table.drawingId,
    ),
    positiveSequences: check(
      "assistant_conversations_sequences",
      sql`${table.nextMessageSequence} > 0 and ${table.nextEventSequence} > 0`,
    ),
  }),
)

export const assistantRuns = pgTable(
  "assistant_runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversationId")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    status: text("status", { enum: runStatuses }).notNull().default("queued"),
    control: text("control", { enum: runControls })
      .notNull()
      .default("running"),
    controlVersion: integer("controlVersion").notNull().default(1),
    acknowledgedControlVersion: integer("acknowledgedControlVersion")
      .notNull()
      .default(0),
    firstInputSequence: integer("firstInputSequence").notNull(),
    lastInputSequence: integer("lastInputSequence").notNull(),
    receivedThroughSequence: integer("receivedThroughSequence")
      .notNull()
      .default(0),
    // Stable credential identity, not a bearer token or a mutable display name.
    credentialKind: text("credentialKind", { enum: credentialKinds }),
    credentialId: text("credentialId"),
    workerId: text("workerId"),
    workerState: text("workerState", { enum: workerStates }),
    leaseGeneration: integer("leaseGeneration").notNull().default(0),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: timestamp("finishedAt"),
  },
  (table) => ({
    conversationRun: unique("assistant_runs_conversation_id").on(
      table.conversationId,
      table.id,
    ),
    oneActive: uniqueIndex("assistant_runs_one_active")
      .on(table.conversationId)
      .where(sql`${table.status} in ('queued', 'running', 'awaiting_input')`),
    validState: check(
      "assistant_runs_state",
      sql`${table.status} in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled') and ${table.control} in ('running', 'paused')`,
    ),
    versions: check(
      "assistant_runs_versions",
      sql`${table.controlVersion} > 0 and ${table.acknowledgedControlVersion} between 0 and ${table.controlVersion}`,
    ),
    sequences: check(
      "assistant_runs_sequences",
      sql`${table.firstInputSequence} > 0 and ${table.lastInputSequence} >= ${table.firstInputSequence} and ${table.receivedThroughSequence} >= 0`,
    ),
    worker: check(
      "assistant_runs_worker",
      sql`(
      (${table.workerId} is null and ${table.credentialKind} is null and ${table.credentialId} is null and ${table.workerState} is null and ${table.leaseGeneration} = 0 and ${table.leaseExpiresAt} is null)
      or
      (${table.workerId} is not null and ${table.credentialId} is not null and ${table.credentialKind} is not null and ${table.credentialKind} in ('access_token', 'oauth_grant') and ${table.workerState} is not null and ${table.workerState} in ('working', 'paused', 'awaiting_input') and ${table.leaseGeneration} > 0)
    )`,
    ),
    finished: check(
      "assistant_runs_finished",
      sql`(${table.finishedAt} is not null) = (${table.status} in ('completed', 'failed', 'cancelled'))`,
    ),
  }),
)

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversationId")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    runId: text("runId").notNull(),
    sequence: integer("sequence").notNull(),
    source: text("source", { enum: ["member", "worker"] }).notNull(),
    kind: text("kind", { enum: messageKinds }).notNull(),
    body: text("body"),
    requestId: text("requestId").notNull(),
    requestHash: text("requestHash").notNull(),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    ordered: uniqueIndex("assistant_messages_sequence").on(
      table.conversationId,
      table.sequence,
    ),
    deduplication: uniqueIndex("assistant_messages_request").on(
      table.conversationId,
      table.source,
      table.requestId,
    ),
    run: foreignKey({
      columns: [table.conversationId, table.runId],
      foreignColumns: [assistantRuns.conversationId, assistantRuns.id],
    }).onDelete("cascade"),
    validContent: check(
      "assistant_messages_content",
      sql`${table.sequence} > 0 and (
      (${table.source} = 'member' and ${table.kind} = 'user' and ${table.body} is not null and char_length(${table.body}) between 1 and 10000)
      or (${table.source} = 'worker' and ${table.kind} = 'assistant' and ${table.body} is not null and char_length(${table.body}) between 1 and 10000)
      or (${table.source} = 'member' and ${table.kind} in ('pause', 'resume', 'cancel') and ${table.body} is null)
    )`,
    ),
  }),
)

export const assistantEvents = pgTable(
  "assistant_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversationId")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    runId: text("runId").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind", { enum: eventKinds }).notNull(),
    data: jsonb("data").$type<EventData>().notNull(),
    requestId: text("requestId"),
    requestHash: text("requestHash"),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    ordered: uniqueIndex("assistant_events_sequence").on(
      table.conversationId,
      table.sequence,
    ),
    deduplication: uniqueIndex("assistant_events_request").on(
      table.conversationId,
      table.requestId,
    ),
    run: foreignKey({
      columns: [table.conversationId, table.runId],
      foreignColumns: [assistantRuns.conversationId, assistantRuns.id],
    }).onDelete("cascade"),
    validEvent: check(
      "assistant_events_content",
      sql`${table.sequence} > 0 and jsonb_typeof(${table.data}) = 'object' and ${table.kind} in ('message_created', 'run_created', 'run_claimed', 'run_controlled', 'run_acknowledged', 'run_reported', 'scene_committed') and ((${table.requestId} is null) = (${table.requestHash} is null))`,
    ),
  }),
)

/** Immutable proof that a particular assistant edit reached durable scene storage. */
export const assistantOperations = pgTable(
  "assistant_operations",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversationId")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    runId: text("runId").notNull(),
    requestId: text("requestId").notNull(),
    requestHash: text("requestHash").notNull(),
    summary: text("summary").notNull(),
    before: jsonb("before").$type<SceneElement[]>().notNull(),
    after: jsonb("after").$type<SceneElement[]>().notNull(),
    beforeSettings: jsonb("beforeSettings").$type<Partial<SceneSettings>>(),
    afterSettings: jsonb("afterSettings").$type<Partial<SceneSettings>>(),
    sceneRevision: integer("sceneRevision").notNull(),
    createdAt: timestamp("createdAt")
      .notNull()
      .$defaultFn(() => new Date()),
    undoOf: text("undoOf").references(
      (): AnyPgColumn => assistantOperations.id,
      { onDelete: "cascade" },
    ),
    revertedAt: timestamp("revertedAt"),
  },
  (table) => ({
    request: uniqueIndex("assistant_operations_request").on(
      table.conversationId,
      table.requestId,
    ),
    oneUndo: uniqueIndex("assistant_operations_undo").on(table.undoOf),
    run: foreignKey({
      columns: [table.conversationId, table.runId],
      foreignColumns: [assistantRuns.conversationId, assistantRuns.id],
    }).onDelete("cascade"),
    revision: check(
      "assistant_operations_revision",
      sql`${table.sceneRevision} > 0 and char_length(${table.summary}) between 1 and 200 and jsonb_typeof(${table.before}) = 'array' and jsonb_typeof(${table.after}) = 'array'`,
    ),
  }),
)

export const assistantWorkers = pgTable(
  "assistant_workers",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialKind: text("credentialKind", { enum: credentialKinds }).notNull(),
    credentialId: text("credentialId").notNull(),
    workerId: text("workerId").notNull(),
    name: text("name").notNull(),
    lastSeenAt: timestamp("lastSeenAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [
        table.userId,
        table.credentialKind,
        table.credentialId,
        table.workerId,
      ],
    }),
    valid: check(
      "assistant_workers_identity",
      sql`${table.credentialKind} in ('access_token', 'oauth_grant') and char_length(${table.workerId}) between 1 and 128 and char_length(${table.name}) between 1 and 100`,
    ),
  }),
)
