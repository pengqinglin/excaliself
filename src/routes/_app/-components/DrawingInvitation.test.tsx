import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { DrawingInvitation } from "./DrawingInvitation"

const api = vi.hoisted(() => ({
  create: vi.fn(),
  control: vi.fn(),
  prepare: vi.fn(),
  clipboard: vi.fn(),
}))
vi.mock("@/features/assistant/server", () => ({
  createDrawingInvitation: api.create,
  controlDrawingInvitation: api.control,
}))
vi.mock("@/features/drawings/use-drawing-writer", () => ({
  useDrawingWriter: () => ({ prepare: api.prepare }),
}))
const grant = {
  id: "grant",
  expiresAt: new Date(Date.now() + 60_000),
  lastSeenAt: null,
  clientName: null,
  control: "running" as const,
}
beforeEach(() => {
  vi.resetAllMocks()
  api.prepare.mockResolvedValue({
    barrier: { connectionId: "socket", requestId: "sync" },
  })
  api.create.mockResolvedValue({
    ...grant,
    token: "exs_canvas_test_secret",
    drawingId: "this-drawing",
  })
  api.control.mockResolvedValue({})
  api.clipboard.mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: api.clipboard },
  })
})
afterEach(cleanup)

test("opening waits for complete sync, copies the actual scoped invitation and keeps it when collapsed", async () => {
  let finish = () => {}
  api.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ barrier: { connectionId: "socket", requestId: "sync" } })
      }),
  )
  function Host() {
    const [open, setOpen] = useState(true)
    const [invitation, setInvitation] = useState<typeof grant | null>(null)
    return (
      <>
        <button type="button" onClick={() => setOpen(!open)}>
          Toggle panel
        </button>
        <DrawingInvitation
          conversationId="conversation"
          invitation={invitation}
          paused={false}
          workState={null}
          open={open}
          onOpen={() => setOpen(true)}
          invalidate={async () => {
            if (api.create.mock.calls.length) setInvitation(grant)
          }}
        />
      </>
    )
  }
  render(<Host />)
  await waitFor(() => expect(api.prepare).toHaveBeenCalledOnce())
  expect(api.create).not.toHaveBeenCalled()
  await act(async () => finish())
  const copy = await screen.findByRole("button", {
    name: "Copy AI instructions",
  })
  fireEvent.click(copy)
  await screen.findByRole("button", { name: "Copied · paste into your AI" })
  const markdown = api.clipboard.mock.calls[0][0] as string
  expect(markdown).toContain(`${window.location.origin}/draw/this-drawing`)
  expect(markdown).toContain(`${window.location.origin}/api/mcp`)
  expect(markdown).toContain("Authorization: Bearer exs_canvas_test_secret")
  expect(markdown).toContain("canvas_read")
  expect(markdown).toContain("canvas_commit")
  fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }))
  expect(
    screen.queryByRole("button", { name: "Copied · paste into your AI" }),
  ).toBeNull()
  expect(screen.getByRole("button", { name: "I'll draw" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }))
  expect(
    screen.getByRole("button", { name: "Copied · paste into your AI" }),
  ).toBeTruthy()
  expect(api.create).toHaveBeenCalledOnce()
})

test("takeover calls the server before displaying human control; resume waits for the last stroke barrier", async () => {
  let paused = false
  let refresh = () => {}
  function Host() {
    const [, renderAgain] = useState(0)
    refresh = () => renderAgain((value) => value + 1)
    return (
      <DrawingInvitation
        conversationId="conversation"
        invitation={{ ...grant, control: paused ? "paused" : "running" }}
        paused={paused}
        workState={null}
        open
        onOpen={() => {}}
        invalidate={async () => refresh()}
      />
    )
  }
  let finishPause = () => {}
  api.control.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishPause = () => {
          paused = true
          resolve({})
        }
      }),
  )
  render(<Host />)
  fireEvent.click(screen.getByRole("button", { name: "I'll draw" }))
  expect(screen.queryByText("Your turn · AI writes paused")).toBeNull()
  await act(async () => finishPause())
  await screen.findByText("Your turn · AI writes paused")
  let finishSync = () => {}
  api.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishSync = () =>
          resolve({
            barrier: { connectionId: "socket", requestId: "last-stroke" },
          })
      }),
  )
  api.control.mockResolvedValue({})
  fireEvent.click(screen.getByRole("button", { name: "Hand back to AI" }))
  expect(api.control).toHaveBeenCalledTimes(1)
  await act(async () => finishSync())
  await waitFor(() =>
    expect(api.control).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation",
        grantId: "grant",
        command: "resume",
        barrier: { connectionId: "socket", requestId: "last-stroke" },
      },
    }),
  )
})

test("failed synchronization never creates a drawing grant", async () => {
  api.prepare.mockRejectedValue(new Error("Scene not saved"))
  render(
    <DrawingInvitation
      conversationId="conversation"
      invitation={null}
      paused={false}
      workState={null}
      open
      onOpen={() => {}}
      invalidate={async () => {}}
    />,
  )
  await screen.findByRole("alert")
  expect(api.create).not.toHaveBeenCalled()
})

test.each(["opening", "rotation"])(
  "%s keeps the new secret across delayed query notifications and hides obsolete secrets",
  async (mode) => {
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const props = {
      conversationId: "conversation",
      paused: false,
      workState: null,
      open: true,
      onOpen: () => {},
      invalidate,
    }
    const initial = mode === "opening" ? null : { ...grant, id: "old-grant" }
    const view = render(<DrawingInvitation {...props} invitation={initial} />)
    if (mode === "rotation")
      fireEvent.click(screen.getByRole("button", { name: "New key" }))
    // Refetch resolves before React receives the query's notification.
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("Saving the complete canvas…")).toBeNull()
    view.rerender(<DrawingInvitation {...props} invitation={grant} />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy AI instructions" }),
    )
    await waitFor(() => expect(api.clipboard).toHaveBeenCalledOnce())
    expect(api.clipboard.mock.calls[0][0]).toContain(
      "Bearer exs_canvas_test_secret",
    )
    view.rerender(
      <DrawingInvitation
        {...props}
        invitation={{ ...grant, id: "rotated-in-another-tab" }}
      />,
    )
    expect(
      screen.queryByRole("button", { name: "Copied · paste into your AI" }),
    ).toBeNull()
    expect(screen.queryByText(/Bearer exs_canvas_test_secret/)).toBeNull()
  },
)
