import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  AssistantMcpClient,
  ConnectorError,
} from "../src/features/assistant/connector/client"
import { createCodexExecutor } from "../src/features/assistant/connector/codex"
import { runConnector } from "../src/features/assistant/connector/runner"
import { openConnectorState } from "../src/features/assistant/connector/state"

if (process.argv.includes("--help")) {
  console.log(
    "Excaliself Codex connector\nRequired: EXCALISELF_URL and EXCALISELF_TOKEN\nOptional: EXCALISELF_CONNECTOR_STATE_DIR, EXCALISELF_CODEX_BIN, EXCALISELF_CODEX_MODEL, EXCALISELF_CODEX_TIMEOUT_MS\nRun continuously with: pnpm assistant:codex\nAuthenticate Codex first with: codex login",
  )
} else {
  let state: Awaited<ReturnType<typeof openConnectorState>> | undefined
  try {
    const base = process.env.EXCALISELF_URL
    const token = process.env.EXCALISELF_TOKEN
    if (!base || !token)
      throw new Error(
        "Set EXCALISELF_URL and EXCALISELF_TOKEN before starting the connector",
      )
    const url = new URL(base)
    if (!url.pathname.replace(/\/$/, "").endsWith("/api/mcp"))
      url.pathname = `${url.pathname.replace(/\/$/, "")}/api/mcp`
    const endpoint = url.toString()
    const directory =
      process.env.EXCALISELF_CONNECTOR_STATE_DIR ??
      join(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
        "excaliself-codex",
        createHash("sha256").update(endpoint).digest("hex").slice(0, 16),
      )
    const client = new AssistantMcpClient(endpoint, token)
    const timeoutMs = Number(
      process.env.EXCALISELF_CODEX_TIMEOUT_MS ?? 1_800_000,
    )
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 2_147_483_647
    )
      throw new Error(
        "EXCALISELF_CODEX_TIMEOUT_MS must be between 1000 and 2147483647",
      )
    state = await openConnectorState(directory, endpoint)
    const workspace = join(directory, "workspace")
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    const stop = new AbortController()
    const end = () => stop.abort()
    process.once("SIGINT", end)
    process.once("SIGTERM", end)
    try {
      console.log(`Codex connector started (${state.data.workerId})`)
      await runConnector({
        client,
        state,
        signal: stop.signal,
        execute: createCodexExecutor({
          endpoint,
          token,
          directory: workspace,
          binary: process.env.EXCALISELF_CODEX_BIN,
          model: process.env.EXCALISELF_CODEX_MODEL,
          timeoutMs,
        }),
        log: (message) => console.log(`[connector] ${message}`),
      })
    } finally {
      process.removeListener("SIGINT", end)
      process.removeListener("SIGTERM", end)
    }
  } catch (error) {
    console.error(
      error instanceof ConnectorError
        ? `Connector stopped: ${error.code}`
        : error instanceof Error
          ? error.message
          : "Connector stopped",
    )
    process.exitCode = 1
  } finally {
    await state?.close()
  }
}
