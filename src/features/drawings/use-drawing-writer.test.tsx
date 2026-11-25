import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, expect, test, vi } from "vitest"
import { drawingQueryOptions } from "./queries"
import { prepareDrawingServerWriter } from "./server"
import { usePrepareDrawingWriter } from "./use-drawing-writer"

vi.mock("./server", () => ({
  prepareDrawingServerWriter: vi.fn(),
  getDrawingWithFiles: vi.fn(),
  getDrawings: vi.fn(),
}))
vi.mock("./scene", () => ({
  buildScenePayload: ({ elements }: { elements: unknown[] }) => ({
    data: JSON.stringify({ elements }),
    files: [],
  }),
}))
beforeEach(() => vi.clearAllMocks())

function setup(isRoom = false) {
  const client = new QueryClient()
  client.setQueryData(drawingQueryOptions("d").queryKey, {
    id: "d",
    sceneRevision: 3,
    serverManagedAt: null,
  } as never)
  let resolve = () => {}
  const drained = new Promise<void>((done) => {
    resolve = done
  })
  const release = vi.fn()
  const hold = vi.fn(() => ({ drained, release }))
  const onConflict = vi.fn()
  let elements = [{ id: "initial" }]
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({}),
    getFiles: () => ({}),
  }
  const hook = renderHook(
    () =>
      usePrepareDrawingWriter({
        drawingId: "d",
        api: api as never,
        hold,
        isRoom,
        readOnly: false,
        onConflict,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
  return {
    client,
    hook,
    release,
    hold,
    onConflict,
    resolve,
    edit: () => {
      elements = [{ id: "latest" }]
    },
  }
}

test("prepare drains saves before capturing latest API state; duplicate calls share the handoff", async () => {
  const { hook, resolve, edit, hold, release, client } = setup()
  vi.mocked(prepareDrawingServerWriter).mockResolvedValue({
    status: "activated",
    serverManagedAt: new Date(),
    sceneRevision: 5,
  })
  let first: Promise<unknown>
  await act(async () => {
    first = hook.result.current.prepare()
    expect(hook.result.current.prepare()).toBe(first)
    expect(prepareDrawingServerWriter).not.toHaveBeenCalled()
    edit()
    resolve()
    await first
  })
  expect(hold).toHaveBeenCalledTimes(1)
  expect(prepareDrawingServerWriter).toHaveBeenCalledWith({
    data: {
      id: "d",
      expectedRevision: 3,
      snapshot: { data: '{"elements":[{"id":"latest"}]}', files: [] },
    },
  })
  expect(client.getQueryData(drawingQueryOptions("d").queryKey)).toMatchObject({
    sceneRevision: 5,
    serverManagedAt: expect.any(Date),
  })
  expect(release).toHaveBeenCalledWith(false)
})

test("network failure releases held edits for autosave and does not mark the drawing managed", async () => {
  const { hook, resolve, release, client } = setup()
  vi.mocked(prepareDrawingServerWriter).mockRejectedValue(new Error("offline"))
  await act(async () => {
    resolve()
    await expect(hook.result.current.prepare()).rejects.toThrow("offline")
  })
  expect(release).toHaveBeenCalledWith(true)
  expect(client.getQueryData(drawingQueryOptions("d").queryKey)).toMatchObject({
    serverManagedAt: null,
  })
})

test("a conflicting snapshot stops autosave and cannot silently overwrite another tab", async () => {
  const { hook, resolve, release, onConflict } = setup()
  vi.mocked(prepareDrawingServerWriter).mockResolvedValue({
    status: "conflict",
    sceneRevision: 4,
  })
  await act(async () => {
    resolve()
    await expect(hook.result.current.prepare()).rejects.toThrow("Reload")
  })
  expect(onConflict).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledWith(false)
})

test("an existing Room never sends a browser scene snapshot during promotion", async () => {
  const { hook, resolve } = setup(true)
  vi.mocked(prepareDrawingServerWriter).mockResolvedValue({
    status: "activated",
    serverManagedAt: new Date(),
    sceneRevision: 5,
  })
  await act(async () => {
    resolve()
    await hook.result.current.prepare()
  })
  expect(prepareDrawingServerWriter).toHaveBeenCalledWith({
    data: { id: "d", expectedRevision: 3, snapshot: undefined },
  })
})
