import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

const pendingReport = z.object({
  conversationId: z.string(),
  runId: z.string(),
  workerId: z.string().optional(),
  generation: z.number().int().positive(),
  controlVersion: z.number().int().positive(),
  requestId: z.string(),
  kind: z.enum(["completed", "awaiting_input", "failed"]),
  body: z.string().min(1).max(20_000),
})
const diskSchema = z.object({
  version: z.literal(1),
  endpoint: z.string(),
  memberId: z.string().optional(),
  workerId: z.string().uuid(),
  threads: z.record(z.string(), z.string()),
  pending: z.record(z.string(), pendingReport),
})
export type PendingReport = z.infer<typeof pendingReport>
export type ConnectorState = z.infer<typeof diskSchema>
export interface StateStore {
  readonly data: ConnectorState
  update(change: (state: ConnectorState) => void): Promise<void>
}

/** One identity per state directory, with an atomic, credential-free journal. */
export async function openConnectorState(directory: string, endpoint: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const lockPath = join(directory, "connector.lock")
  try {
    const oldPid = Number(await readFile(lockPath, "utf8"))
    if (!Number.isInteger(oldPid) || oldPid <= 0)
      throw new Error(
        "Invalid connector lock; inspect the state directory before removing it",
      )
    try {
      process.kill(oldPid, 0)
      throw new Error("A connector is already using this state directory")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      await unlink(lockPath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const lock = await open(lockPath, "wx", 0o600)
  await lock.writeFile(String(process.pid))
  await lock.close()
  const statePath = join(directory, "state.json")
  let data: ConnectorState
  try {
    try {
      data = diskSchema.parse(JSON.parse(await readFile(statePath, "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      data = {
        version: 1,
        endpoint,
        workerId: randomUUID(),
        threads: {},
        pending: {},
      }
    }
    if (data.endpoint !== endpoint)
      throw new Error(
        "This state directory belongs to a different MCP endpoint",
      )
  } catch (error) {
    await unlink(lockPath)
    throw error
  }
  let writes = Promise.resolve()
  const store: StateStore & { close(): Promise<void> } = {
    get data() {
      return data
    },
    update(change) {
      const write = writes.then(async () => {
        const next = structuredClone(data)
        change(next)
        diskSchema.parse(next)
        const temporary = join(directory, `state-${randomUUID()}.tmp`)
        const file = await open(temporary, "wx", 0o600)
        try {
          await file.writeFile(JSON.stringify(next))
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, statePath)
        data = next
      })
      writes = write.then(
        () => {},
        () => {},
      )
      return write
    },
    async close() {
      await writes
      await unlink(lockPath)
    },
  }
  try {
    await store.update(() => {})
  } catch (error) {
    await store.close()
    throw error
  }
  return store
}
