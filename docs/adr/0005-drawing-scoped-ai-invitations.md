# 0005 — Drawing-scoped direct AI invitations

Status: accepted (REQ-012, 2026-11-26).

ADR 0003's ordinary account MCP continues to propose scene edits for Apply.
ADR 0004's acknowledged, leased tasks and authoritative single-process Room
remain the only assistant scene writer. Enabling AI assistance is a separate,
explicit grant of direct write authority for one member/drawing conversation.

The application serves the existing `/api/mcp` endpoint. A drawing invitation
uses a random 256-bit secret stored only as a SHA-256 hash, expires after 24 hours,
and is checked on every HTTP request and again in task write transactions.
Rotation revokes its predecessor and ends the previous active task. Current
member access, trash, revocation and expiry are enforced server-side. No account
token, model key, private instruction history or other drawing is exposed.

Drawing credentials register a separate six-tool MCP server. `canvas_read`
establishes an invitation-source task and an acknowledged credential-bound lease
generation, then reads through the existing scene store. Each read fences earlier
generations. `canvas_commit` reuses the existing conflict planner, Room queue,
atomic scene/receipt transaction and idempotency checks. `canvas_get_operation`
recovers receipts without a live lease. Managed connectors cannot discover or
claim invitation tasks. Local instruction chat is available after closing direct
access; external instructions stay in the external conversation.

Enabling, rotating or handing back AI access requires a browser scene barrier.
The browser flushes images, waits for settings acknowledgments, sends its whole
scene, then requests `SCENE_SYNC` on that same socket. The Room's serial queue
persists all preceding updates and verifies referenced image bytes before sending
`SCENE_SYNCED(saved=true)`. A barrier belongs to that member's currently seated
connection and is invalidated by subsequent scene/settings frames. The grant
mutation checks it inside the same Room queue. Disconnect, timeout or database
failure never grants AI access. PONG and image upload success are insufficient.

Human takeover advances task control before reporting success, or pauses an
invitation that has no task yet. Resume requires a saved browser barrier and a
fresh acknowledged read. Old control versions and lease generations never revive.
External clients may continue polling, but Excaliself cannot kill their model
processes or awaken an ended AI conversation. Only durable operation receipts
mean saved; copying, connectivity and model completion are separate states.

The existing one-application-process deployment rule remains: PostgreSQL locks
serialize task/grant transactions, while the single Room serializes human and AI
scene mutations. This decision does not introduce distributed Room ownership.
