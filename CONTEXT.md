# Ubiquitous Language

## Terms

### Home
The state of the canvas area when no drawing is open. Shown inside the normal app shell (sidebar visible) — not a standalone landing page. Presents recent Drawings (with Previews) and the create action; doubles as the empty state when the user has no Drawings yet. Also the landing spot after actions that orphan the user, such as deleting the currently open Drawing or following a link to a Drawing that no longer exists.

### Recent
Drawings ordered by when they were last edited (not created, not opened). Editing a Drawing is the only thing that makes it "recent".

### Drawing
A single Excalidraw document created by a member, living in a Space, identified by id, in that Space's folder tree shown in the sidebar.

### Space
Where a Drawing or folder lives: Private or Team. A folder's whole subtree is always in one Space. A member can see and act on an item iff they are its Creator or it is in Team; this one rule replaces every per-item ownership check.

### Private
One member's own Space. Only that member sees it. Works the way the app did before Team existed, Share links included. Every Drawing and folder made before Team is Private.

### Team
The instance's one shared Space. Every member sees and can do everything with every Team Drawing and folder, with no sharing step. Never called "Shared": "shared" means "has a Share link".

### Creator
The member who created a Drawing or folder. For a Private item, the only member who can see it. A Team item outlives its Creator: when that member is deleted, the item stays with no Creator ("Former member").

### Canvas area
The inset region to the right of the sidebar. Shows either an open Drawing or Home.

### Create dialog
The single way a Drawing or folder is created: a command-style dialog where the user types a name and confirms. Everything is deliberately named at birth; the app never creates a Drawing on the user's behalf.

### Gallery
The app's one grid of Drawing cards (Preview, name, folder attribution, edited-ago), ordered by Recent unless a Browse toolbar re-sorts it. Home shows it capped at 8; All drawings shows it whole; later surfaces (folder pages, trash) reuse it rather than fork it.

### All drawings
The browse surface at `/drawings`: the Gallery over every Drawing the user owns, uncapped, under the Browse toolbar. Reached from Home's "View all" link.

### Browse toolbar
The Gallery's filter chrome on All drawings: on-page search (the app's only inline filter — there is no search-results page), folder chips (All / one per folder / Unfiled) that scope the grid, and a sort dropdown (Last edited default / Date created / Name). Search and chip scope compose. While Team is on, search covers both Spaces even on a page scoped to one, and each match carries a Space label; the chips (the page Space's folders) still narrow it. Folder pages reuse it without the chip row.

### Preview
A non-interactive visual rendering of a Drawing's scene, shown on Gallery cards so drawings are recognizable by shape rather than name.

### Room
The authoritative scene of one shared, Team, or server-managed Private Drawing. There is at most one Room per Drawing. Participants keep it live; a background assistant command can also hold a temporary Room without a socket. An empty written Room is released. Guests enter through a Share link; members enter Team or server-managed drawings by id under their existing access rule.

### Handoff
The swap of who owns a Drawing's stored data. An unshared Private Drawing starts with its Creator's autosave; sharing or moving to Team gives its Room the writing role. Starting an Assistant task first commits the final solo snapshot and permanently marks the Drawing server-managed, using a scene revision check and atomic image storage. Old solo saves are then refused. Stopping sharing hands back only an ordinary unpromoted Private Drawing. Team and server-managed Drawings keep their Room writer (ADR 0002 and ADR 0004).

### Share link
The one live edit link a Drawing can have (`/share/<token>`), minted and managed by the owner from the Share dialog. "Shared" is derived — a Drawing is shared iff its link exists; stopping sharing deletes it, regenerating replaces the token (old URL dies). Carries an Audience: `members` (any signed-in member of this instance, the default) or `anyone` (no account needed). A link whose token, Audience, or Drawing no longer checks out is dead — every dead link looks identical, revealing nothing about whether the Drawing exists.

### Participant
One socket connected to a Room, as everyone else in it sees it: a display name, an assigned cursor color, and whether it belongs to a member or a guest. Identified by a Connection id, never by a userId — a member's account never crosses the wire to a guest. A member's name comes from their session and cannot be set from the client; a guest's is a pseudonym it generates and keeps in its own browser.

### Connection id
The random id a socket is given when it joins a Room, and the only handle other Participants have on it. Ephemeral by design (spec §4.4): reconnecting produces a new one, so it is not an identity that can be tracked or blocked — abuse limits key on IP instead.

### Heartbeat
A tiny frame each Participant sends every ~25 s, and the answer the server sends back. It exists to be traffic: a Room where everyone is reading rather than drawing is a live session, and without it a reverse proxy's idle timeout would close the sockets out from under it. The answer is the second half — a Participant whose heartbeat goes unanswered treats its Connection as dead even though the socket still claims to be open, which is the only way a connection that died without saying so is ever noticed.

### Reconnecting
The state of a Participant whose socket has dropped: the canvas stays live and editable, edits keep landing locally, and the client dials the Room again on a jittered backoff, indefinitely. Announced by one quiet indicator and nothing else — no warning, no retry button, and never any "lost work" language, because there is none: the rejoin merges what was drawn during the outage with whatever the Room has. Two answers end it instead of another dial — the Room is full, or the Share link is dead.

### Following
A one-way arrangement between two Participants in a Room: the follower's canvas rides along with the followed Participant's viewport, marked by a ring in that Participant's color and a chip naming them. Started by clicking their avatar, ended by clicking the chip, their avatar, panning or zooming, or by them leaving. Nobody can be made to follow, and being followed changes nothing about what the followed Participant can do — only that their viewport is relayed to whoever is watching.

### Live badge
What a member sees on a Drawing they can see that has a Room with someone *else* in it — any Team Drawing, or a Private one they created: a stack of Participant avatars on the Gallery card, a count on the sidebar row. Their own connections never count, so a Drawing they alone have open wears no badge. Ambient rather than exact — it is polled, so it trails joins and leaves by up to half a minute, and it is not a control: clicking a badged card just opens the Drawing, which joins the Room.

### Scene image
An image on a Drawing's canvas, stored as bytes under a content-addressed file id that the image element on the scene points at. Bytes and elements travel separately in a Room: the element syncs like any other element, while the bytes go over a room-scoped HTTP endpoint the same Share link opens. An image is *saved* once its bytes are stored — which is the signal other Participants use to fetch them — *pending* until then, and *errored* when the store refused it (too large, or too many uploads), in which case nobody fetches it and everyone sees a placeholder.

### Team library
The instance's one set of reusable shapes and icons, shown in the editor's Library panel in every Drawing, Private or Team. Every member sees and edits the same items, stored on the server; a member's add or remove reaches teammates' open editors live. Guests on a Share link neither see nor change it. Not tied to the Team Space despite the name: it is the team's, not a Space's.

### Access token
A secret a member makes under Settings so their own AI client can use the instance over MCP (`/api/mcp`). It acts as that member under the Space rule. Ordinary drawing edits create Proposals for the member's Apply; member-started Assistant tasks authorize fenced background commits through the Room. It can also read and write Comments and manage the member's accessible items. Shown once, when made. Revoking it ends access immediately and releases its unfinished task leases. It opens no Share link and has no Audience.

### Connected app
An AI client, such as a Claude.ai connector, that a member let in through OAuth instead of an Access token: the client asks, the member signs in and clicks Allow. Same access and same limits as an Access token. Listed beside the tokens in Settings, where the member disconnects it; disconnecting, or deleting its member, ends it at once.

### Proposal
A change to a Drawing's scene that an AI client asks for (Access token or Connected app): elements to add, change, or remove. It changes nothing by itself. Only the member the client acts as sees it, as a card on the Drawing in each of their tabs, and they Apply or Discard it. Apply puts it on that tab's canvas as the member's own edit, so the Drawing's one writer (its Room, or autosave) carries it and undo takes it back (ADR 0003). It goes stale if an element it changes moved on before the Apply, and expires after 30 minutes. A new Proposal for the same Drawing replaces the member's open one. Held in memory, so a restart drops it.

### Comment thread
A conversation pinned to one Anchor on one Drawing: open or resolved. Exists while it holds at least one Comment. Lives beside the scene, never in it, so it never touches the Room, autosave, undo, exports, or the `.excalidraw` file. Whoever can see the Drawing can read, start, reply to, resolve, and reopen its threads; guests on a Share link see none.

### Assistant conversation
A persistent private conversation for one member and one Drawing. Other members and guests see its resulting drawing edits under normal access, but never its messages or controls. Closing a page does not end it. Clients authenticated as that member can act on it.

### Assistant task
One unfinished execution in an Assistant conversation, started by a member's instruction. A durable control version and a 60-second generation-fenced lease coordinate the Codex connector. A new instruction interrupts the old execution; Pause fences later writes; Trash cancels the task. Completed means a final response was recorded, not that a drawing write occurred.

### Operation receipt
The immutable before/after payload of a committed assistant drawing edit, stored in the same transaction as the scene and its private event. Request IDs make retries idempotent. A member can reverse their operation within 30 days if the affected revisions/settings still match. The reversal is a new receipt and atomically pauses that conversation's active task; unrelated human edits remain.

### Codex connector
A continuously running process that polls MCP as one member, executes Codex CLI with that member's login, independently renews task leases and watches controls. Its private local journal retains a persistent machine identity, per-conversation Codex thread references and unconfirmed reports. Each process adds a distinct execution instance to its worker ID so a restarted connector cannot reuse an orphan's active lease.

### OpenCode connector
An alternative executor for the same Assistant tasks, using OpenCode's configured model and credentials. It reads the current drawing through MCP, keeps a native session per conversation, and uses the same fenced commits, controls and receipt recovery. The member sees the connected executor's name in Settings and the drawing panel; an online connector is distinct from a successful model result.

### Comment
One plain-text message in a Comment thread, by one member (or their AI client, shown as "via" its name). The first one opens the thread. Only its author edits or deletes it.

### Anchor
Where a Comment thread's Pin sits: a canvas point, or an element plus a spot on it, as a fraction of its box. An element Anchor follows the element as it moves, resizes, and rotates.

### Pin
A Comment thread's marker over the canvas. DOM, not a scene element. Resolved threads' Pins are hidden unless "Show resolved" is on.

### Detached
A Comment thread whose Anchor element was deleted. Its Pin stays where the element was, and re-attaches if the element comes back by undo.
