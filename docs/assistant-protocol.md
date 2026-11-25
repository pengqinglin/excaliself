# Assistant protocol v1

MCP transport remains Streamable HTTP at `/api/mcp`, authenticated on every
request with a personal token or OAuth access token. The transport negotiates its
own MCP version; `assistant_poll.protocolVersion = 1` identifies this task API.

The caller's user and stable credential IDs come from authentication. Tool input
contains a workerId, never a userId or credentialId. A connector combines its
persistent machine UUID with a new UUID for each process. Keep that identity
unchanged during a process's lease and include the exact claimed generation.

| Tool | Input beyond workerId | Result / rule |
| --- | --- | --- |
| assistant_poll | optional name | protocolVersion, memberId, tasks visible to this worker; records presence |
| assistant_claim | conversationId, runId | Run with leaseGeneration, leaseExpiresAt and controlVersion |
| assistant_work | conversationId, runId, afterSequence, limit | Current run and ordered private message page; follow nextCursor while hasMore |
| assistant_heartbeat | conversationId, runId, generation | Renews lease for 60 seconds; never acknowledges input |
| assistant_acknowledge | lease fields, controlVersion, throughSequence | Confirms receiving all latest input and controls |
| assistant_report | lease fields, controlVersion, requestId, kind, body | progress / awaiting_input / completed / failed; idempotent message/event |
| assistant_read_scene | lease fields, controlVersion | Authoritative elements, description, base revisions, settings and recent operation receipts |
| assistant_commit_edit | lease fields, controlVersion, requestId, summary, base, add/change/remove, optional settings | Saved operation receipt after the scene/operation/event transaction commits |
| assistant_get_operation | conversationId, requestId | Saved receipt or null, also available after the lease is lost |

`base` maps affected element IDs to `{version, versionNonce}`. Add/change/remove
use the existing simple shape/arrow planner format. Include revisions for bound
labels and connectors the planner must touch. A settings change uses
`{base: fullSceneSettings, patch: changedFields}`. Only patched fields are compared.

A normal worker sequence is poll → claim → read every work page → acknowledge →
read scene → commit edit(s) → report. Renew every 15–20 seconds independently of
model execution. Poll controls every 2 seconds during work. Stop the execution
on pause, cancellation, changed input/control, lost lease, revoked credential or
missing drawing. Confirm a pause only after the execution has stopped.

On an uncertain commit response, call assistant_get_operation with the same
requestId. Retry the identical payload with that ID; reusing the ID for another
payload or lease context yields idempotency_conflict. To replan after a conflict,
read again and choose a new request ID. Recent operations include undoOf and
revertedAt; preserve member reversals unless explicitly instructed otherwise.

Final-report retries use the same member, original workerId and complete report
input. A replacement credential belonging to that member can recover an already
committed report after an uncertain response. Creating a new report still requires
the credential-bound live lease; changing members cannot read or replay it.

Known business errors return MCP `isError: true` with text JSON
`{"error":{"code":"…","message":"…"}}`. Codes include not_found,
invalid_input, run_busy, lease_lost, stale_control, paused, input_unacknowledged,
credential_revoked, scene_conflict, writer_required and idempotency_conflict.
Unexpected errors return internal_error without SQL parameters. HTTP 401/403
ends use of that credential.

Member messages and controls are authenticated web server functions. Sending the
first task requires the drawing's one-way server-managed handoff. The only scene
write proof is a saved operation ID and revision; a completed report can answer a
question without changing the drawing. Ordinary edit_drawing continues to create
a proposal under ADR 0003; task commits follow ADR 0004.
