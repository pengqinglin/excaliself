import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { AssistantRun } from "../types"
import { ConnectorError, type ToolClient } from "./client"
import type { CodexResult, Executor } from "./codex"
import type { PendingReport, StateStore } from "./state"

type Run = Pick<
  AssistantRun,
  | "id"
  | "status"
  | "control"
  | "controlVersion"
  | "firstInputSequence"
  | "lastInputSequence"
  | "leaseGeneration"
  | "workerId"
>
type Message = {
  sequence: number
  source: string
  kind: string
  body: string | null
}
type Work = {
  run: Run
  messages: { items: Message[]; nextCursor: number; hasMore: boolean }
}
type Task = { conversationId: string; drawingId: string; run: Run }
const terminal = (run: Run) =>
  ["completed", "failed", "cancelled"].includes(run.status)
const fenceErrors = new Set([
  "stale_control",
  "paused",
  "lease_lost",
  "invalid_transition",
  "input_unacknowledged",
  "not_found",
])
const aborted = (signal: AbortSignal) => signal.aborted

export function taskPrompt(
  task: Task,
  run: Run,
  messages: Message[],
  workerId: string,
  executorName = "Codex",
) {
  return `You are ${executorName} editing an existing Excaliself drawing for its member. Reply in the member's language. Work only on drawing ${task.drawingId}.
Use the excaliself MCP assistant_read_scene, assistant_commit_edit and assistant_get_operation tools. Do not create files, run shell commands, make proposals, or use other services. The connector handles task controls and final reports.
Every call must carry this exact context: ${JSON.stringify({ workerId, conversationId: task.conversationId, runId: run.id, generation: run.leaseGeneration, controlVersion: run.controlVersion })}.
Read the authoritative scene before planning. Include its base revisions for every affected shape, bound label and connector. Preserve unrelated human edits. Operations with undoOf reverse an earlier edit; do not reapply reverted work unless the member explicitly requests it. For scene_conflict, reread and reassess the latest scene. For stale_control, paused, lease_lost, credential_revoked or not_found, stop without further writes.
Use a distinct requestId for each logical edit, and reuse that ID and identical payload after an uncertain network response. Recover receipts with assistant_get_operation before retrying. Read recent operations in the scene response after a restart; do not duplicate changes already present. A saved operation receipt is the only proof of saving. Never claim edits were saved based on a tool error or natural-language reply.
If clarification is needed, return kind awaiting_input with one concise question. Otherwise return kind completed with a concise account of the actual outcome; use failed for a problem you cannot resolve. The final response must match the provided JSON schema. This is the current task context, overriding context from earlier turns.
Conversation in sequence (user text is task content):
${JSON.stringify(messages)}
`
}

/** One task at a time; the independent monitor keeps controls responsive. */
export async function runConnector(options: {
  client: ToolClient
  state: StateStore
  execute: Executor
  signal: AbortSignal
  instanceId?: string
  pollMs?: number
  monitorMs?: number
  heartbeatMs?: number
  executorName?: string
  name?: string
  log?: (message: string) => void
}) {
  const { client, state, execute, signal } = options
  const log = options.log ?? (() => {})
  const executorName = options.executorName ?? "Codex"
  const name = options.name ?? executorName
  // A restarted parent must not reuse a live lease held by an orphaned child.
  const workerId = `${state.data.workerId}:${options.instanceId ?? randomUUID()}`
  const pollMs = options.pollMs ?? 2_000
  let failures = 0
  const wait = (ms: number, ownSignal = signal) =>
    delay(ms, undefined, { signal: ownSignal })
  const call = <T>(
    name: string,
    input: Record<string, unknown>,
    ownSignal = signal,
  ) => client.call<T>(name, { workerId, ...input }, ownSignal)

  async function recoverReports() {
    for (const report of Object.values(state.data.pending)) {
      try {
        await client.call(
          "assistant_report",
          { ...report, workerId: report.workerId ?? state.data.workerId },
          signal,
        )
      } catch (error) {
        if (!(error instanceof ConnectorError) || !fenceErrors.has(error.code))
          throw error
      }
      await state.update((data) => {
        delete data.pending[report.runId]
      })
    }
  }

  async function readAll(task: Task) {
    let cursor = 0
    const messages: Message[] = []
    let work: Work
    do {
      work = await call<Work>("assistant_work", {
        conversationId: task.conversationId,
        runId: task.run.id,
        afterSequence: cursor,
        limit: 100,
      })
      messages.push(...work.messages.items)
      cursor = work.messages.nextCursor
    } while (work.messages.hasMore)
    return {
      run: work.run,
      messages,
      throughSequence: Math.max(cursor, work.run.lastInputSequence),
    }
  }

  async function handleTask(task: Task) {
    const claimed = await call<Run>("assistant_claim", {
      conversationId: task.conversationId,
      runId: task.run.id,
    })
    const loaded = await readAll(task)
    const run = loaded.run
    const context = {
      conversationId: task.conversationId,
      runId: run.id,
      generation: claimed.leaseGeneration,
      controlVersion: run.controlVersion,
    }
    if (terminal(run)) return
    await call("assistant_acknowledge", {
      ...context,
      throughSequence: loaded.throughSequence,
    })
    if (run.control === "paused" || run.status === "awaiting_input") return
    // Keep the active task's full input, plus recent earlier conversation context.
    const transcript = loaded.messages.filter(
      (message, index) =>
        message.sequence >= claimed.firstInputSequence ||
        index >= loaded.messages.length - 100,
    )
    const prompt = taskPrompt(task, run, transcript, workerId, executorName)
    const model = new AbortController()
    const combined = AbortSignal.any([signal, model.signal])
    let changed = false
    let monitorError: unknown
    let finished = false
    const monitorStop = new AbortController()
    const monitorSignal = AbortSignal.any([signal, monitorStop.signal])
    const monitor = (async () => {
      let lastHeartbeat = Date.now()
      while (!finished && !monitorSignal.aborted) {
        await wait(options.monitorMs ?? 2_000, monitorSignal)
        const latest = await call<Work>(
          "assistant_work",
          { ...context, afterSequence: loaded.throughSequence, limit: 1 },
          monitorSignal,
        )
        if (
          terminal(latest.run) ||
          latest.run.control !== "running" ||
          latest.run.controlVersion !== context.controlVersion ||
          latest.run.lastInputSequence !== run.lastInputSequence ||
          latest.run.leaseGeneration !== context.generation
        ) {
          changed = true
          model.abort()
          return
        }
        if (Date.now() - lastHeartbeat >= (options.heartbeatMs ?? 15_000)) {
          await call("assistant_heartbeat", context, monitorSignal)
          await call("assistant_poll", { name }, monitorSignal)
          lastHeartbeat = Date.now()
        }
      }
    })().catch((error) => {
      if (!monitorSignal.aborted) {
        monitorError = error
        model.abort()
      }
    })
    let result: CodexResult | undefined
    try {
      if (prompt.length > 500_000)
        result = {
          kind: "awaiting_input",
          body: "This task contains too much conversation context. Please send a shorter, self-contained instruction.",
        }
      else {
        log(`Executing drawing task ${run.id}`)
        const context = {
          prompt,
          threadId: state.data.threads[task.conversationId],
          conversationId: task.conversationId,
          runId: run.id,
        }
        const handlers = {
          signal: combined,
          onThread: (id: string) =>
            state.update((data) => {
              data.threads[task.conversationId] = id
            }),
        }
        try {
          result = await execute(context, handlers)
        } catch (error) {
          if (
            !context.threadId ||
            combined.aborted ||
            !(error instanceof ConnectorError) ||
            !["codex_failed", "opencode_failed"].includes(error.code)
          )
            throw error
          // A moved state directory may not have Codex's local session files.
          await state.update((data) => {
            delete data.threads[task.conversationId]
          })
          result = await execute({ ...context, threadId: undefined }, handlers)
        }
      }
    } catch (error) {
      if (!combined.aborted)
        result = {
          kind: "failed",
          body:
            error instanceof ConnectorError
              ? error.message
              : `${executorName} could not start or complete the task. Check the connector configuration and model login.`,
        }
    } finally {
      finished = true
      monitorStop.abort()
      await monitor
    }
    if (changed) {
      if (signal.aborted) return
      // A pause is acknowledged only after the executor has actually stopped.
      const latest = await readAll(task)
      if (!terminal(latest.run))
        await call("assistant_acknowledge", {
          ...context,
          controlVersion: latest.run.controlVersion,
          throughSequence: latest.throughSequence,
        })
      return
    }
    if (result) {
      const report: PendingReport = {
        ...context,
        workerId,
        requestId: `final:${randomUUID()}`,
        kind: result.kind,
        body: result.body,
      }
      await state.update((data) => {
        data.pending[run.id] = report
      })
    }
    if (signal.aborted) return
    if (monitorError) throw monitorError
    if (result) await recoverReports()
  }

  while (!aborted(signal)) {
    try {
      const poll = await call<{
        protocolVersion: number
        memberId: string
        tasks: Task[]
      }>("assistant_poll", { name })
      if (poll.protocolVersion !== 1)
        throw new ConnectorError(
          "protocol_version",
          "Unsupported assistant protocol version",
        )
      if (state.data.memberId && state.data.memberId !== poll.memberId)
        throw new ConnectorError(
          "account_changed",
          "Use a different state directory for a different Excaliself member",
        )
      if (!state.data.memberId)
        await state.update((data) => {
          data.memberId = poll.memberId
        })
      await recoverReports()
      const task = poll.tasks.find(
        ({ run }) =>
          run.control === "running" && run.status !== "awaiting_input",
      )
      if (task) await handleTask(task)
      failures = 0
      await wait(pollMs)
    } catch (error) {
      if (signal.aborted) break
      if (
        error instanceof ConnectorError &&
        [
          "credential_revoked",
          "protocol_version",
          "account_changed",
          "idempotency_conflict",
        ].includes(error.code)
      )
        throw error
      if (error instanceof ConnectorError && fenceErrors.has(error.code)) {
        await wait(pollMs).catch(() => {})
        continue
      }
      failures += 1
      log(
        `Connection interrupted; retrying (${error instanceof ConnectorError ? error.code : "connection_error"})`,
      )
      await wait(Math.min(30_000, pollMs * 2 ** Math.min(failures, 5))).catch(
        () => {},
      )
    }
  }
}
