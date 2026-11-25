// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { createCodexExecutor } from "./codex"

test("Codex invocation resumes the saved thread, keeps the bearer out of argv, and parses only the final message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-process-"))
  try {
    const execute = createCodexExecutor({
      endpoint: "http://localhost/api/mcp",
      token: "secret-not-an-argument",
      directory,
      binary: process.execPath,
      prefixArgs: [
        fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)),
      ],
    })
    const threads: string[] = []
    const result = await execute(
      {
        prompt: "Draw",
        threadId: "previous-thread",
        conversationId: "c",
        runId: "r",
      },
      {
        signal: new AbortController().signal,
        onThread: async (id) => {
          threads.push(id)
        },
      },
    )
    expect(threads).toEqual(["fixture-thread"])
    const args = JSON.parse(result.body)
    expect(args).toContain("resume")
    expect(args).toContain("previous-thread")
    expect(args).toContain("read-only")
    expect(result.body).not.toContain("secret-not-an-argument")
    expect(result.body).not.toContain("private reasoning")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("pause aborts an actual running child process and waits for its exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-abort-"))
  try {
    const execute = createCodexExecutor({
      endpoint: "http://localhost/api/mcp",
      token: "secret",
      directory,
      binary: process.execPath,
      prefixArgs: [
        fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)),
      ],
    })
    const stop = new AbortController()
    await expect(
      execute(
        { prompt: "WAIT", conversationId: "c", runId: "r" },
        {
          signal: stop.signal,
          onThread: async () => {
            stop.abort()
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
