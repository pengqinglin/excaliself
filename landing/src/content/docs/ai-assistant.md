---
title: "AI assistant: invite your AI to a drawing"
description: Copy a short-lived connection invitation, let your AI edit this drawing directly, and take back the pen at any time.
---

Open an existing drawing and choose **AI assistant**. The app saves the complete
scene and its images, then enables a drawing-only invitation for 24 hours. Choose
**Copy AI instructions** and paste the Markdown into your AI conversation together
with your drawing request. No model or model API key is configured in Excaliself.

The invitation includes this instance's actual drawing URL, drawing ID, remote
`/api/mcp` endpoint, Bearer secret, expiry and tool instructions. The application
already serves Streamable HTTP MCP; there is no second MCP server to deploy.
Your AI client must support registering and calling a remote MCP. Some clients
need connection settings or a reload before the tools become available. A chat
page without MCP/tool execution cannot connect just by reading the instructions.
The address must be reachable from the AI's machine; localhost works only when
the client and the application run on the same machine.

## Drawing access and handing over the pen

The invitation permits reading and directly changing **only this drawing**,
under the member's current access rights. It exposes `canvas_status`,
`canvas_read`, `canvas_heartbeat`, `canvas_commit`, `canvas_get_operation` and
`canvas_finish`. It cannot list other drawings, read your private task chat or
use account administration tools. Ordinary `edit_drawing` still proposes changes
that require Apply. Keep the copied secret private; it is shown only at creation
and the database stores only its hash. Reloading requires **New key** to copy a
replacement. A new key immediately invalidates the old one, including clients
that already connected. **Turn off access** revokes it; expiry also blocks later
requests. Opening a drawing/share URL alone does not grant MCP access.

**I'll draw** pauses new AI writes as soon as the server confirms the handoff.
Earlier saved operations stay saved. You can add, drag, delete, pan and zoom in
the same canvas. **Hand back to AI** first waits for your latest scene, settings
and image uploads to be durably saved. The AI must read again for a fresh work
context; old plans cannot commit after the handoff. Conflicting edits must reread
the affected elements; unrelated human edits survive.

The app can block an external client's saves, but cannot terminate an independent
AI process or awaken an ended conversation. A client that is polling can discover
the handoff. If your AI has finished its turn, say **continue** in that AI chat.
Every read issues a new context, and a 60-second lease needs `canvas_heartbeat`
at least every 20 seconds while the AI works. Another client cannot take a live
lease; generate a new key when switching clients immediately.

The panel sits beside the desktop canvas and below it on narrow screens. Closing
the panel preserves access and leaves a compact status/control bar. **Copied**,
**Client connected**, **AI is working** and **Saved to the drawing** mean different
things: only a persisted operation receipt confirms a saved scene change. Revert
uses the same 30-day conflict checks described below.

Your conversation and task controls are private to your account. The resulting
drawing edits are visible to anyone who can access that drawing. A private drawing
stays private; starting an assistant task does not create a share link.

## Start the Codex connector

For durable tasks entered in the web panel, turn off the drawing invitation to
show the existing private task chat, then use a managed connector below. Creating
or replacing an invitation ends the previous active task so it cannot keep the pen.

The connector runs continuously on your computer or a server. It uses your Codex
CLI login and talks to Excaliself over MCP. The Excaliself application needs no
model API key. A connected MCP server alone does not start Codex; the connector
receives tasks and launches it.

1. On the connector machine, install Node.js 22, pnpm 11.14.0 and the
   [Codex CLI](https://developers.openai.com/codex/cli/). The connector targets
   Codex CLI 0.160.0 and uses `exec --json`, `resume` and HTTP MCP. The CLI arguments
   and connector protocol are verified; remote model execution requires your login.
2. Run `codex login` as the user who will run the connector. Keep the Codex model
   configuration you normally use.
3. Check out the same Excaliself source version as your application and install
   its dependencies with `pnpm install --frozen-lockfile`.
4. In Excaliself, open **Settings → MCP** and create a personal access token.
   This token acts as your member account.
5. From the checkout, set the instance address and token, then start the connector.
   The following commands use Bash; paste the token after `read` and press Enter.
   Its input is hidden.

```bash
export EXCALISELF_URL='https://draw.example.com'
read -rs EXCALISELF_TOKEN
export EXCALISELF_TOKEN
pnpm assistant:codex
```

The connector also accepts an address ending in `/api/mcp`. Its status appears in
**Settings → MCP** and the drawing's assistant panel. Leave the process running,
or run it as a service as described below. The application image runs the web app;
the connector runs separately from its source checkout.

## Use OpenCode instead

The OpenCode connector uses the same task protocol, current drawing data, saved
receipts and pause controls. It uses OpenCode's existing provider configuration
and credentials on the connector machine; no model key is entered in Excaliself.
Install OpenCode and confirm that `opencode run` can reach your chosen model.
The connector has been checked with OpenCode 1.19.6.

Create a personal access token under **Settings → MCP**, then run from an
Excaliself checkout with its dependencies installed:

```bash
export EXCALISELF_URL='http://127.0.0.1:3131'
read -rs EXCALISELF_TOKEN
export EXCALISELF_TOKEN
pnpm assistant:opencode
```

Use your application's actual address. `127.0.0.1` works when the connector and
application run on the same machine. To select a model explicitly, set
`EXCALISELF_OPENCODE_MODEL` to an installed `provider/model` identifier before
starting the connector; otherwise OpenCode's default model applies.

The connector starts OpenCode with an isolated drawing agent that can use only
`assistant_read_scene`, `assistant_commit_edit` and `assistant_get_operation`.
It supplies the MCP address and Excaliself token to the new process without
changing your global OpenCode configuration. Existing OpenCode terminal sessions
keep their loaded configuration; restart a terminal session after adding MCP
configuration to that session separately.

**Settings → MCP** shows this instance's MCP address and commands for either
connector. An online connector's name appears there and in the drawing panel;
an explicitly selected OpenCode model appears alongside its name. Online means
the connector is polling successfully; the task result reports whether model
execution and drawing changes succeeded.

For an end-to-end check, start with an existing “Browser → API → Database”
drawing, then send “Read this drawing and insert a Redis cache between the API
and database, preserving the existing colors.” The AI must read the current
elements, preserve their identities, update the connectors and obtain a saved
receipt. Send a follow-up such as “Add a cache-miss label to the database arrow”
to continue on the same drawing and native AI session.

OpenCode-specific settings are `EXCALISELF_OPENCODE_BIN` (default `opencode`),
`EXCALISELF_OPENCODE_MODEL` and `EXCALISELF_OPENCODE_TIMEOUT_MS` (default 30
minutes). The default state directory is under
`$XDG_STATE_HOME/excaliself-opencode/`, or `~/.local/state/excaliself-opencode/`.
Use a different state directory for each member, endpoint and executor. For a
user service, adapt the Codex service example to run `pnpm assistant:opencode`
under the account whose OpenCode model is configured.

## Work on an existing drawing

1. Open the drawing and choose **AI assistant** (also in the editor menu on a
   narrow screen). Turn off drawing access to use the managed connector task chat.
2. Send an instruction, for example “Add a cache between the API and database,
   using the same colors as the existing diagram.”
3. The first send saves and hands the current scene to the server. You can
   continue editing while Codex works. Unrelated edits are preserved; if the
   shapes Codex planned to change have moved on, it must read them again.
4. Follow the message and task statuses. **Message saved** means Excaliself has
   stored your instruction. **Received by Codex** means its connector confirmed
   it. **Saved to the drawing** identifies a committed drawing operation.
5. Reply if Codex asks a question. A new instruction updates the current task
   and interrupts the old execution so it can work from your latest input.

You can close the panel, switch drawings or close the browser. A running connector
continues the task. Reopening the panel restores your conversation and receipts.
If the connector is offline, instructions stay queued in PostgreSQL.

Private drawings used with the assistant remain server-managed afterwards.
Background color and grid settings then synchronize with the drawing's other
participants; theme, selection and viewport stay local to each browser.
Stopping a share link removes that link's access while the owner keeps editing
through the private Room. Team drawings keep their existing access rules.

If the handoff reports that another tab saved newer changes, copy any local work
you want to keep before using **Reload drawing**. The page pauses automatic
saving so it cannot overwrite the newer scene.

## Pause, continue and cancel

**Pause** blocks later drawing commits as soon as the server accepts it. The
panel shows that stopping is in progress until the connector confirms it has
stopped the execution. An edit committed before the pause remains saved.
**Continue** saves the complete browser scene first, then lets the connector pick
up the latest instructions again.

**Cancel task** ends the task. Saved drawing changes have their own receipts and
can be reverted. Moving a drawing or its folder to Trash also cancels its tasks.
Restoring the drawing lets you start a new task; it does not restart the old one.

**Task completed** is Codex's final response. Drawing persistence is indicated by
the saved-operation cards, which are recorded with the scene in PostgreSQL.

## Revert a saved change

Choose **Revert** on an operation card. It restores only that operation's affected
shapes, labels, connectors and settings. Reverting also pauses the current task,
so you can decide the next instruction before Codex continues.

Revert is available for 30 days while the affected content is unchanged. If
someone changed it afterwards, the operation is refused without changing the
drawing. Unrelated changes remain. A reversal gets its own saved receipt; that
receipt has no further revert button. Use the panel to revert assistant edits;
the editor's ordinary undo history handles your local edits.

Images needed by an operation's reversal are retained during this window. The
normal drawing image budget still applies to those retained bytes.

## Run continuously with systemd

The repository includes
[`docs/examples/excaliself-codex.service`](https://github.com/maciekzygmunt/excaliself/blob/main/docs/examples/excaliself-codex.service)
and an environment-file example. Run a user service under the same account used
for `codex login`:

1. Put the environment file at `~/.config/excaliself-codex.env`, fill in the URL
   and personal token, and set its permissions to `600`.
2. Copy the service file to `~/.config/systemd/user/excaliself-codex.service`.
   Set `WorkingDirectory` to your checkout and adjust `ExecStart` or the service's
   PATH to the installed pnpm and Node 22 paths. Systemd does not load shell profiles.
3. Run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now excaliself-codex
journalctl --user -u excaliself-codex -f
```

If the service should survive logging out of the connector machine, enable user
lingering with `loginctl enable-linger "$USER"` (your administrator may need to
enable it). The service's stop timeout allows the connector to terminate Codex
and finish its local journal.

## Connector settings and recovery

These variables belong to the **connector process**, not the application container:

| Variable | Meaning |
| --- | --- |
| `EXCALISELF_URL` | Required instance address, or its `/api/mcp` endpoint |
| `EXCALISELF_TOKEN` | Required personal access token |
| `EXCALISELF_CONNECTOR_STATE_DIR` | Optional dedicated state directory; default is under `$XDG_STATE_HOME/excaliself-codex/`, or `~/.local/state/excaliself-codex/`, grouped by endpoint |
| `EXCALISELF_CODEX_BIN` | Optional path to the Codex executable; default `codex` |
| `EXCALISELF_CODEX_MODEL` | Optional model override; otherwise uses Codex's configuration |
| `EXCALISELF_CODEX_TIMEOUT_MS` | Per-execution limit in milliseconds; default `1800000` (30 minutes) |

Keep one state directory for each member and endpoint. The directory holds a
persistent connector identity, Codex thread references and any final response
whose delivery is not yet confirmed. It contains conversation results, so keep
its private file permissions. The token is not stored there. A second process
cannot use the same state directory concurrently.

After a forced stop, a new execution instance waits for an outstanding lease to
expire (up to 60 seconds). Old executions cannot write after their lease expires
or another instance claims a newer generation. A saved but unconfirmed final
response is replayed with its original request identity. If Codex's native thread
files are unavailable, the connector starts again from the database conversation
and saved-operation context.

Revoking the Excaliself token stops that connector and releases its unfinished
work for a replacement credential. Create a replacement token and restart the
service. The web application continues to require **one application process**
for its authoritative Rooms; persistent tasks do not add multi-replica Room support.

For application backups, see [Backup and restore](/docs/backup-restore/). Preview
mode uses in-memory data and loses tasks, conversations and scenes on restart.
