import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AssistantRun } from "@/features/assistant/types"
import { AssistantPanel } from "./AssistantPanel"

const api = vi.hoisted(() => ({
  open: vi.fn(),
  state: vi.fn(),
  history: vi.fn(),
  send: vi.fn(),
  control: vi.fn(),
  prepare: vi.fn(),
  revert: vi.fn(),
}))
vi.mock("@/features/account/queries", () => ({
  currentUserQueryOptions: () => ({
    queryKey: ["current-user"],
    queryFn: async () => ({ id: "member" }),
    staleTime: Number.POSITIVE_INFINITY,
  }),
}))
vi.mock("@/features/drawings/use-drawing-writer", () => ({
  useDrawingWriter: () => ({ prepare: api.prepare, preparing: false }),
}))
vi.mock("@/features/assistant/server", () => ({
  openAssistantConversation: api.open,
  getAssistantPanelState: api.state,
  getAssistantHistory: api.history,
  sendAssistantMessage: api.send,
  controlAssistantRun: api.control,
  revertAssistantOperation: api.revert,
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  api.open.mockResolvedValue({ id: "conversation" })
  api.state.mockResolvedValue({
    activeRun: null,
    latestRun: null,
    operations: [],
    connections: [],
  })
  api.history.mockResolvedValue({ items: [], hasMore: false })
  api.prepare.mockResolvedValue({ status: "activated" })
  api.send.mockResolvedValue({})
  api.control.mockResolvedValue({})
})

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const close = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = render(
    <AssistantPanel drawingId="drawing" open onClose={close} />,
    { wrapper },
  )
  return { client, close, ...view }
}
const run: AssistantRun = {
  id: "run",
  conversationId: "conversation",
  status: "running",
  control: "running",
  controlVersion: 1,
  acknowledgedControlVersion: 1,
  firstInputSequence: 1,
  lastInputSequence: 1,
  receivedThroughSequence: 1,
  credentialKind: "access_token",
  credentialId: "credential",
  workerId: "worker",
  workerState: "working",
  leaseGeneration: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  finishedAt: null,
}

test("sending waits for the final drawing handoff and only then clears the draft", async () => {
  let finish = () => {}
  api.prepare.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  setup()
  const input = await screen.findByRole("textbox")
  await waitFor(() => expect(api.state).toHaveBeenCalled())
  fireEvent.change(input, { target: { value: "Move the API" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  await waitFor(() => expect(api.prepare).toHaveBeenCalledOnce())
  expect(api.send).not.toHaveBeenCalled()
  expect((input as HTMLTextAreaElement).value).toBe("Move the API")
  finish()
  await waitFor(() =>
    expect(api.send).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation",
        body: "Move the API",
        requestId: expect.any(String),
      },
    }),
  )
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""))
})

test("the panel identifies the real connected executor instead of assuming Codex", async () => {
  api.state.mockResolvedValue({
    activeRun: run,
    latestRun: run,
    operations: [],
    connections: [
      {
        workerId: "worker",
        name: "OpenCode · provider/model",
        lastSeenAt: new Date(),
      },
    ],
  })
  setup()
  await screen.findByText("OpenCode · provider/model")
  expect(await screen.findByText("AI connector online")).toBeTruthy()
  expect(screen.getByRole("status").textContent).toBe("AI is working")
})

test("a failed send preserves the draft and retries the identical request ID", async () => {
  api.send.mockRejectedValueOnce(new Error("Response lost"))
  setup()
  const input = await screen.findByRole("textbox")
  await waitFor(() => expect(api.state).toHaveBeenCalled())
  fireEvent.change(input, { target: { value: "Make it blue" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  await screen.findByRole("alert")
  expect((input as HTMLTextAreaElement).value).toBe("Make it blue")
  const first = api.send.mock.calls[0][0]
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2))
  expect(api.send.mock.calls[1][0]).toEqual(first)
})

test("pause, continue and cancel use the latest control version; closing never cancels", async () => {
  let current = { ...run }
  api.state.mockImplementation(async () => ({
    activeRun: current,
    latestRun: current,
    operations: [],
    connections: [
      { workerId: "worker", name: "Codex", lastSeenAt: new Date() },
    ],
  }))
  api.control.mockImplementation(
    async ({ data }: { data: { command: string } }) => {
      current = {
        ...current,
        controlVersion: current.controlVersion + 1,
        control: data.command === "pause" ? "paused" : "running",
      }
      return {}
    },
  )
  const { close } = setup()
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }))
  await waitFor(() =>
    expect(api.control).toHaveBeenCalledWith({
      data: expect.objectContaining({
        command: "pause",
        expectedControlVersion: 1,
      }),
    }),
  )
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }))
  await waitFor(() =>
    expect(api.control).toHaveBeenCalledWith({
      data: expect.objectContaining({
        command: "resume",
        expectedControlVersion: 2,
      }),
    }),
  )
  fireEvent.click(await screen.findByRole("button", { name: "Cancel task" }))
  await waitFor(() => expect(api.control).toHaveBeenCalledTimes(3))
  fireEvent.click(screen.getByRole("button", { name: "Close" }))
  expect(close).toHaveBeenCalledOnce()
  expect(api.control).toHaveBeenCalledTimes(3)
})

test("a completed answer is separate from saved drawing receipts and renders content as text", async () => {
  api.state.mockResolvedValue({
    activeRun: null,
    latestRun: { ...run, status: "completed", finishedAt: new Date() },
    operations: [],
    connections: [],
  })
  api.history.mockResolvedValue({
    items: [
      {
        id: "message",
        sequence: 1,
        source: "worker",
        kind: "assistant",
        runId: "run",
        body: "<img src=x onerror=alert(1)>",
        createdAt: new Date(),
      },
    ],
    hasMore: false,
  })
  setup()
  await screen.findByText("Task completed")
  expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy()
  expect(screen.getByRole("log").querySelector("img")).toBeNull()
  expect(screen.queryByText("Saved to the drawing")).toBeNull()
})

test("the panel displays durable receipts and loads earlier history on demand", async () => {
  api.state.mockResolvedValue({
    activeRun: null,
    latestRun: null,
    operations: [
      {
        id: "operation",
        summary: "Add API",
        sceneRevision: 3,
        createdAt: new Date(),
      },
    ],
    connections: [],
  })
  api.history.mockImplementation(
    async ({ data }: { data: { beforeSequence?: number } }) => ({
      items: [
        {
          id: data.beforeSequence ? "old" : "new",
          sequence: data.beforeSequence ? 1 : 2,
          source: "member",
          kind: "user",
          body: data.beforeSequence
            ? "Earlier instruction"
            : "Latest instruction",
          createdAt: new Date(),
        },
      ],
      hasMore: !data.beforeSequence,
      previousCursor: data.beforeSequence ? 1 : 2,
    }),
  )
  setup()
  await screen.findByText("Saved to the drawing")
  fireEvent.click(
    await screen.findByRole("button", { name: "Load earlier messages" }),
  )
  await screen.findByText("Earlier instruction")
  expect(api.history).toHaveBeenCalledWith({
    data: { conversationId: "conversation", beforeSequence: 2, limit: 50 },
  })
})

test("revert uses the receipt ID and reports a conflict without claiming success", async () => {
  api.state.mockResolvedValue({
    activeRun: null,
    latestRun: null,
    operations: [
      {
        id: "operation",
        summary: "Move API",
        canUndo: true,
        sceneRevision: 3,
        createdAt: new Date(),
      },
    ],
    connections: [],
  })
  api.revert.mockResolvedValue({ status: "conflict" })
  setup()
  fireEvent.click(await screen.findByRole("button", { name: "Revert" }))
  await waitFor(() =>
    expect(api.revert).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation",
        operationId: "operation",
        requestId: expect.any(String),
      },
    }),
  )
  await screen.findByRole("alert")
  expect(screen.queryByText("Reversal saved to the drawing")).toBeNull()
})
