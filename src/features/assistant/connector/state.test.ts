// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openConnectorState } from "./state"

test("a private atomic state journal survives restart, serializes updates and holds one process lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-state-"))
  try {
    const state = await openConnectorState(
      directory,
      "http://localhost/api/mcp",
    )
    const identity = state.data.workerId
    await expect(
      openConnectorState(directory, "http://localhost/api/mcp"),
    ).rejects.toThrow("already using")
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        state.update((data) => {
          data.threads[`conversation-${index}`] = `thread-${index}`
        }),
      ),
    )
    await state.update((data) => {
      data.pending.run = {
        conversationId: "conversation",
        runId: "run",
        generation: 1,
        controlVersion: 1,
        requestId: "result",
        kind: "completed",
        body: "Saved",
      }
    })
    await state.close()
    const reopened = await openConnectorState(
      directory,
      "http://localhost/api/mcp",
    )
    expect(reopened.data.workerId).toBe(identity)
    expect(Object.keys(reopened.data.threads)).toHaveLength(5)
    expect(reopened.data.pending.run.requestId).toBe("result")
    expect((await stat(join(directory, "state.json"))).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(directory, "state.json"), "utf8")).not.toContain(
      "Bearer",
    )
    await reopened.close()
    await expect(
      openConnectorState(directory, "http://different/api/mcp"),
    ).rejects.toThrow("different MCP endpoint")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
