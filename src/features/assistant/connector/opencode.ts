import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { ConnectorError } from "./client"
import { codexResult, type Executor } from "./codex"

/** Use OpenCode's existing provider login; only the drawing tools are allowed. */
export function openCodeDrawingConfig(endpoint: string) {
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    snapshot: false,
    mcp: {
      excaliself: {
        type: "remote",
        url: endpoint,
        oauth: false,
        headers: { Authorization: "Bearer {env:EXCALISELF_TOKEN}" },
        timeout: 25_000,
      },
    },
    agent: {
      "excaliself-drawing": {
        mode: "primary",
        description:
          "Read and edit the member's active Excaliself drawing task",
        prompt:
          'Work only through the excaliself assistant_read_scene, assistant_commit_edit and assistant_get_operation MCP tools. The connector handles task controls. Do not use files, shell commands or other agents. Return one JSON object, without Markdown: {"kind":"completed"|"awaiting_input"|"failed","body":"concise reply in the member\'s language"}. Only a saved operation receipt proves a drawing was changed.',
        permission: {
          "*": "deny",
          excaliself_assistant_read_scene: "allow",
          excaliself_assistant_commit_edit: "allow",
          excaliself_assistant_get_operation: "allow",
        },
      },
    },
  }
}

export function createOpenCodeExecutor(config: {
  endpoint: string
  token: string
  directory: string
  binary?: string
  prefixArgs?: string[]
  model?: string
  timeoutMs?: number
  log?: (message: string) => void
}): Executor {
  return async (context, { signal, onThread }) => {
    signal.throwIfAborted()
    const args = [
      ...(config.prefixArgs ?? []),
      "--pure",
      "run",
      "--format",
      "json",
      "--agent",
      "excaliself-drawing",
    ]
    if (config.model) args.push("--model", config.model)
    if (context.threadId) args.push("--session", context.threadId)
    const child = spawn(config.binary ?? "opencode", args, {
      cwd: config.directory,
      env: {
        ...process.env,
        EXCALISELF_TOKEN: config.token,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(
          openCodeDrawingConfig(config.endpoint),
        ),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      },
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
    let finalText = ""
    let threadId: string | undefined
    let outputFailure: unknown
    let failed = false
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
          outputFailure = new Error("OpenCode event exceeds the limit")
          stop()
          continue
        }
        try {
          const event = JSON.parse(line)
          if (typeof event.sessionID === "string" && !threadId) {
            const sessionId: string = event.sessionID
            threadId = sessionId
            await onThread(sessionId)
          }
          if (event.type === "step_start") finalText = ""
          if (event.type === "text" && typeof event.part?.text === "string")
            finalText += event.part.text
          if (event.type === "error") failed = true
          const tool = event.part?.tool
          if (
            event.type === "tool_use" &&
            typeof tool === "string" &&
            [
              "excaliself_assistant_read_scene",
              "excaliself_assistant_commit_edit",
              "excaliself_assistant_get_operation",
            ].includes(tool)
          )
            config.log?.(`${tool}: ${event.part.state?.status ?? "updated"}`)
        } catch (error) {
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
          "opencode_timeout",
          "OpenCode exceeded its execution time limit",
        )
      if (code !== 0 || failed)
        throw new ConnectorError(
          "opencode_failed",
          "OpenCode could not complete this execution; check its model login and MCP configuration",
        )
      try {
        return codexResult.parse(JSON.parse(finalText.trim()))
      } catch {
        throw new ConnectorError(
          "opencode_output",
          "OpenCode did not return a valid final result",
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
