// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { createOpenCodeExecutor, openCodeDrawingConfig } from "./opencode"

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-process-"))
  const execute = createOpenCodeExecutor({
    endpoint: "http://localhost/api/mcp",
    token: "secret-not-an-argument",
    directory,
    binary: process.execPath,
    prefixArgs: [
      fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url)),
    ],
    model: "provider/model",
  })
  return {
    execute,
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

test("OpenCode resumes its session, isolates drawing tool permissions and keeps credentials out of arguments", async () => {
  const { execute, close } = await setup()
  try {
    const threads: string[] = []
    const result = await execute(
      {
        prompt: "Draw",
        threadId: "previous-session",
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
    expect(threads).toEqual(["fixture-session"])
    expect(JSON.parse(result.body)).toEqual(
      expect.arrayContaining([
        "--session",
        "previous-session",
        "provider/model",
      ]),
    )
    expect(result.body).not.toContain("secret-not-an-argument")
    expect(result.body).not.toContain("private reasoning")
    const config = openCodeDrawingConfig("http://localhost/api/mcp")
    expect(config.mcp.excaliself.headers.Authorization).toBe(
      "Bearer {env:EXCALISELF_TOKEN}",
    )
    expect(config.agent["excaliself-drawing"].permission).toEqual({
      "*": "deny",
      excaliself_assistant_read_scene: "allow",
      excaliself_assistant_commit_edit: "allow",
      excaliself_assistant_get_operation: "allow",
    })
  } finally {
    await close()
  }
})

test("OpenCode abort waits for the actual child process to exit", async () => {
  const { execute, close } = await setup()
  const stop = new AbortController()
  try {
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
    await close()
  }
})

test.each(["INVALID", "ERROR"])(
  "OpenCode %s output cannot be mistaken for a completed task",
  async (prompt) => {
    const { execute, close } = await setup()
    try {
      await expect(
        execute(
          { prompt, conversationId: "c", runId: "r" },
          {
            signal: new AbortController().signal,
            onThread: async () => {},
          },
        ),
      ).rejects.toMatchObject({
        code: prompt === "ERROR" ? "opencode_failed" : "opencode_output",
      })
    } finally {
      await close()
    }
  },
)
