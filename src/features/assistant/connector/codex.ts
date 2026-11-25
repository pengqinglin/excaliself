import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { ConnectorError } from "./client"

export const codexResult = z.object({
  kind: z.enum(["completed", "awaiting_input", "failed"]),
  body: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .refine((value) => [...value].length <= 10_000 && !value.includes("\0")),
})
export type CodexResult = z.infer<typeof codexResult>
export type ExecutionContext = {
  prompt: string
  threadId?: string
  conversationId: string
  runId: string
}
export type Executor = (
  context: ExecutionContext,
  options: { signal: AbortSignal; onThread: (id: string) => Promise<void> },
) => Promise<CodexResult>

export function createCodexExecutor(config: {
  endpoint: string
  token: string
  directory: string
  binary?: string
  prefixArgs?: string[]
  model?: string
  timeoutMs?: number
}): Executor {
  return async (context, { signal, onThread }) => {
    signal.throwIfAborted()
    const args = [
      ...(config.prefixArgs ?? []),
      "exec",
      "--skip-git-repo-check",
      "--json",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-c",
      `mcp_servers.excaliself.url=${JSON.stringify(config.endpoint)}`,
      "-c",
      'mcp_servers.excaliself.bearer_token_env_var="EXCALISELF_TOKEN"',
      "-c",
      'mcp_servers.excaliself.enabled_tools=["assistant_read_scene","assistant_commit_edit","assistant_get_operation"]',
      "-c",
      "mcp_servers.excaliself.required=true",
    ]
    if (config.model) args.push("--model", config.model)
    if (context.threadId) args.push("resume", context.threadId)
    args.push(
      "--output-schema",
      fileURLToPath(new URL("./result.schema.json", import.meta.url)),
      "-",
    )
    const child = spawn(config.binary ?? "codex", args, {
      cwd: config.directory,
      env: { ...process.env, EXCALISELF_TOKEN: config.token },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const kill = (kind: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === "win32") child.kill(kind)
        else process.kill(-child.pid, kind)
      } catch {}
    }
    const stop = () => {
      kill("SIGTERM")
      forceKill ??= setTimeout(() => kill("SIGKILL"), 5_000)
      forceKill.unref()
    }
    const timeout = setTimeout(
      () => {
        timedOut = true
        stop()
      },
      config.timeoutMs ?? 30 * 60_000,
    )
    timeout.unref()
    signal.addEventListener("abort", stop, { once: true })
    if (signal.aborted) stop()
    let finalText: string | undefined
    let outputFailure: unknown
    // Drain stderr, but do not forward credentials, tool payloads or reasoning to the chat.
    child.stderr.on("data", () => {})
    child.stdin.on("error", () => {})
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    void exited.catch(() => {})
    child.stdin.end(context.prompt)
    try {
      for await (const line of createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })) {
        if (line.length > 48 * 1024 * 1024) {
          outputFailure = new Error("Codex event exceeds the limit")
          stop()
          continue
        }
        try {
          const event = JSON.parse(line)
          if (
            event.type === "thread.started" &&
            typeof event.thread_id === "string"
          )
            await onThread(event.thread_id)
          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message" &&
            typeof event.item.text === "string"
          )
            finalText = event.item.text
        } catch (error) {
          // A malformed event is harmless; journal write failure must stop work.
          if (!(error instanceof SyntaxError)) {
            outputFailure = error
            stop()
          }
        }
      }
      const code = await exited
      signal.throwIfAborted()
      if (outputFailure) throw outputFailure
      if (timedOut)
        throw new ConnectorError(
          "codex_timeout",
          "Codex exceeded its execution time limit",
        )
      if (code !== 0)
        throw new ConnectorError(
          "codex_failed",
          "Codex could not complete this execution; check its login and configuration",
        )
      try {
        return codexResult.parse(JSON.parse(finalText ?? ""))
      } catch {
        throw new ConnectorError(
          "codex_output",
          "Codex did not return a valid final result",
        )
      }
    } finally {
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      signal.removeEventListener("abort", stop)
      if (child.exitCode === null && child.signalCode === null) {
        kill("SIGKILL")
        await exited.catch(() => {})
      }
    }
  }
}
