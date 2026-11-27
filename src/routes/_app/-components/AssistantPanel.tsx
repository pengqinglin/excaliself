import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  Send,
  Square,
  X,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { currentUserQueryOptions } from "@/features/account/queries"
import { assistantPhase } from "@/features/assistant/presentation"
import {
  assistantConversationOptions,
  assistantKey,
  assistantPanelOptions,
} from "@/features/assistant/queries"
import {
  controlAssistantRun,
  getAssistantHistory,
  revertAssistantOperation,
  sendAssistantMessage,
} from "@/features/assistant/server"
import { useDrawingWriter } from "@/features/drawings/use-drawing-writer"
import { formatAgo } from "@/lib/relative-time"
import { cn } from "@/lib/utils"
import { m } from "@/paraglide/messages"
import { getLocale } from "@/paraglide/runtime"
import { DrawingInvitation } from "./DrawingInvitation"

const phaseLabels = {
  idle: () => m.assistant_status_idle(),
  queued: () => m.assistant_status_queued(),
  receiving: () => m.assistant_status_receiving(),
  working: () => m.assistant_status_working(),
  pausing: () => m.assistant_status_pausing(),
  paused: () => m.assistant_status_paused(),
  awaiting_input: () => m.assistant_status_awaiting_input(),
  completed: () => m.assistant_status_completed(),
  failed: () => m.assistant_status_failed(),
  cancelled: () => m.assistant_status_cancelled(),
  offline: () => m.assistant_status_offline(),
}

export function AssistantPanel({
  drawingId,
  open,
  onClose,
  onOpen,
}: {
  drawingId: string
  open: boolean
  onClose: () => void
  onOpen: () => void
}) {
  const queryClient = useQueryClient()
  const writer = useDrawingWriter()
  const { data: user } = useQuery(currentUserQueryOptions())
  const memberId = user?.id ?? ""
  const conversation = useQuery({
    ...assistantConversationOptions(memberId, drawingId),
    enabled: open && !!memberId,
  })
  const conversationId = conversation.data?.id ?? ""
  const state = useQuery({
    ...assistantPanelOptions(memberId, drawingId, conversationId),
    enabled: !!conversationId,
    refetchInterval: conversationId ? 2_000 : false,
  })
  const history = useInfiniteQuery({
    queryKey: [
      ...assistantKey(memberId, drawingId),
      "messages",
      conversationId,
    ],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      getAssistantHistory({
        data: { conversationId, beforeSequence: pageParam, limit: 50 },
      }),
    getNextPageParam: (page) =>
      page.hasMore ? page.previousCursor : undefined,
    enabled: open && !!conversationId,
    refetchInterval: open ? 2_000 : false,
  })
  const [body, setBody] = useState("")
  const pendingMessage = useRef<{ body: string; requestId: string } | null>(
    null,
  )
  const pendingControl = useRef<{ key: string; requestId: string } | null>(null)
  const pendingRevert = useRef<{
    operationId: string
    requestId: string
  } | null>(null)
  const [undoConflict, setUndoConflict] = useState(false)
  const previousMember = useRef(memberId)
  useEffect(() => {
    if (previousMember.current && previousMember.current !== memberId) {
      setBody("")
      pendingMessage.current = null
      pendingControl.current = null
      pendingRevert.current = null
      setUndoConflict(false)
    }
    previousMember.current = memberId
  }, [memberId])
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: assistantKey(memberId, drawingId),
    })
  const send = useMutation({
    mutationFn: async (text: string) => {
      if (!pendingMessage.current || pendingMessage.current.body !== text)
        pendingMessage.current = { body: text, requestId: crypto.randomUUID() }
      await writer.prepare()
      return sendAssistantMessage({
        data: { conversationId, ...pendingMessage.current },
      })
    },
    onSuccess: (_result, submitted) => {
      setBody((current) => (current.trim() === submitted ? "" : current))
      pendingMessage.current = null
    },
    onSettled: invalidate,
  })
  const control = useMutation({
    mutationFn: async (command: "pause" | "resume" | "cancel") => {
      const run = state.data?.activeRun
      if (!run) return
      const key = `${run.id}:${run.controlVersion}:${command}`
      if (pendingControl.current?.key !== key)
        pendingControl.current = { key, requestId: crypto.randomUUID() }
      const barrier =
        command === "resume" ? (await writer.prepare()).barrier : undefined
      return controlAssistantRun({
        data: {
          conversationId,
          runId: run.id,
          command,
          expectedControlVersion: run.controlVersion,
          requestId: pendingControl.current.requestId,
          barrier,
        },
      })
    },
    onSettled: invalidate,
  })
  const revert = useMutation({
    mutationFn: (operationId: string) => {
      setUndoConflict(false)
      if (pendingRevert.current?.operationId !== operationId)
        pendingRevert.current = { operationId, requestId: crypto.randomUUID() }
      return revertAssistantOperation({
        data: { conversationId, ...pendingRevert.current },
      })
    },
    onSuccess: (result) => {
      setUndoConflict(result.status === "conflict")
      if (result.status === "saved") pendingRevert.current = null
    },
    onSettled: invalidate,
  })
  const messages = [
    ...new Map(
      (
        history.data?.pages
          .slice()
          .reverse()
          .flatMap((page) => page.items) ?? []
      ).map((message) => [message.sequence, message]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence)
  const latestSequence = messages.at(-1)?.sequence
  const end = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  useEffect(() => {
    if (open && latestSequence !== undefined && atBottom.current)
      end.current?.scrollIntoView?.({ block: "end" })
  }, [latestSequence, open])
  const active = state.data?.activeRun
  const latest = active ?? state.data?.latestRun
  const online = !!state.data?.connections.some(
    (connection) =>
      !latest?.workerId || connection.workerId === latest.workerId,
  )
  const phase = assistantPhase(latest, online)
  const length = [...body.trim()].length
  const pending = send.isPending || writer.preparing || revert.isPending
  const submit = () => {
    if (conversationId && length > 0 && length <= 10_000 && !pending) {
      control.reset()
      send.mutate(body.trim())
    }
  }
  const invitation = (
    <DrawingInvitation
      key={`${memberId}:${drawingId}`}
      conversationId={conversationId}
      invitation={state.data?.invitation}
      paused={
        state.data?.invitation?.control === "paused" ||
        active?.control === "paused"
      }
      workState={
        latest?.source === "invitation"
          ? latest.status === "completed"
            ? m.assistant_status_completed()
            : latest.control === "running" &&
                latest.status === "running" &&
                latest.acknowledgedControlVersion === latest.controlVersion &&
                latest.leaseExpiresAt &&
                new Date(latest.leaseExpiresAt).getTime() > Date.now()
              ? m.assistant_status_working()
              : null
          : null
      }
      open={open}
      onOpen={onOpen}
      invalidate={invalidate}
    />
  )

  return (
    <section
      aria-label={m.assistant_title()}
      className={
        open
          ? "z-30 flex h-[45%] w-full shrink-0 flex-col overflow-y-auto border-t border-border/70 bg-background md:h-full md:w-96 md:border-l md:border-t-0"
          : "contents"
      }
    >
      {open && (
        <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">{m.assistant_title()}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {m.assistant_private()}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={m.dialog_close()}
          >
            <X className="size-4" />
          </Button>
        </header>
      )}
      {invitation}
      {open && (
        <>
          {!state.data?.invitation && (
            <div className="shrink-0 border-b border-border/60 px-4 py-3 text-xs">
              <p role="status" className="flex items-center gap-2 font-medium">
                {state.isPending ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    {m.assistant_loading()}
                  </>
                ) : (
                  phaseLabels[phase]()
                )}
              </p>
              <p className="mt-1 text-muted-foreground">
                {state.data?.connections.length
                  ? m.assistant_connected()
                  : m.assistant_disconnected()}
              </p>
              {!!state.data?.connections.length && (
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {state.data.connections.map((connection) => (
                    <li key={connection.workerId} className="break-words">
                      {connection.name}
                    </li>
                  ))}
                </ul>
              )}
              {!state.data?.connections.length && (
                <Link
                  to="/settings/mcp"
                  className="mt-1 inline-block underline underline-offset-2"
                >
                  {m.assistant_connect()}
                </Link>
              )}
              {active?.source === "connector" && (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={control.isPending || pending}
                    onClick={() =>
                      control.mutate(
                        active.control === "paused" ? "resume" : "pause",
                      )
                    }
                  >
                    {active.control === "paused" ? (
                      <Play className="size-3" />
                    ) : (
                      <Pause className="size-3" />
                    )}
                    {active.control === "paused"
                      ? m.assistant_resume()
                      : m.assistant_pause()}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={control.isPending || pending}
                    onClick={() => control.mutate("cancel")}
                  >
                    <Square className="size-3" />
                    {m.assistant_cancel()}
                  </Button>
                </div>
              )}
            </div>
          )}
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
            onScroll={(event) => {
              const node = event.currentTarget
              atBottom.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 100
            }}
          >
            {history.hasNextPage && (
              <Button
                size="sm"
                variant="ghost"
                className="mb-3 w-full"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                {m.assistant_older()}
              </Button>
            )}
            {(conversation.isError || state.isError || history.isError) && (
              <div role="alert" className="mb-3 text-sm text-destructive">
                {m.assistant_load_failed()}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void invalidate()}
                >
                  {m.assistant_retry()}
                </Button>
              </div>
            )}
            {!messages.length && !history.isPending && (
              <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
                {m.assistant_intro()}
              </p>
            )}
            <div
              role="log"
              aria-live="polite"
              aria-label={m.assistant_history()}
              className="flex flex-col gap-4"
            >
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={cn(
                    "min-w-0 rounded-lg p-3",
                    message.source === "member"
                      ? "bg-muted/70"
                      : "border border-border/60",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="font-medium">
                      {message.source === "member"
                        ? m.assistant_you()
                        : m.assistant_speaker()}
                    </span>
                    <time dateTime={new Date(message.createdAt).toISOString()}>
                      {formatAgo(message.createdAt)}
                    </time>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {message.body ??
                      (message.kind === "pause"
                        ? m.assistant_control_pause()
                        : message.kind === "resume"
                          ? m.assistant_control_resume()
                          : m.assistant_control_cancel())}
                  </p>
                  {message.source === "member" &&
                    message.kind === "user" &&
                    latest &&
                    latest.id === message.runId && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {message.sequence <= latest.receivedThroughSequence
                          ? m.assistant_received()
                          : m.assistant_message_saved()}
                      </p>
                    )}
                </article>
              ))}
            </div>
            {!!state.data?.operations.length && (
              <div className="mt-4 border-t border-border/60 pt-3">
                <h3 className="mb-2 text-xs font-medium">
                  {m.assistant_changes()}
                </h3>
                {active && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    {m.assistant_undo_pauses()}
                  </p>
                )}
                <ul className="flex flex-col gap-2">
                  {state.data.operations.map((operation) => (
                    <li
                      key={operation.id}
                      className="rounded-lg border border-border/60 p-3 text-sm"
                    >
                      <p className="break-words">
                        {operation.undoOf
                          ? m.assistant_undo_summary({
                              summary: operation.summary,
                            })
                          : operation.summary}
                      </p>
                      <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="size-3" />
                        {operation.revertedAt
                          ? m.assistant_reverted()
                          : operation.undoOf
                            ? m.assistant_undo_saved()
                            : m.assistant_drawing_saved()}
                      </p>
                      {operation.canUndo && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          title={m.assistant_undo_hint()}
                          disabled={
                            revert.isPending || pending || control.isPending
                          }
                          onClick={() => revert.mutate(operation.id)}
                        >
                          {m.assistant_undo()}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {undoConflict && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {m.assistant_undo_conflict()}
                  </p>
                )}
              </div>
            )}
            <div ref={end} />
          </div>
          {!state.data?.invitation && (
            <form
              className="shrink-0 border-t border-border/60 p-3"
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              {(send.isError || control.isError || revert.isError) && (
                <p role="alert" className="mb-2 text-xs text-destructive">
                  {m.assistant_action_failed()}
                </p>
              )}
              <textarea
                aria-label={m.assistant_input()}
                placeholder={m.assistant_input()}
                rows={3}
                maxLength={20_000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    submit()
                  }
                }}
                className="max-h-40 min-h-20 w-full resize-none rounded-md border border-border/60 bg-well p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "text-xs text-muted-foreground",
                    length > 10_000 && "text-destructive",
                  )}
                >
                  {length > 9_000
                    ? `${new Intl.NumberFormat(getLocale()).format(length)}/${new Intl.NumberFormat(getLocale()).format(10_000)}`
                    : m.assistant_background()}
                </span>
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  disabled={
                    !conversationId ||
                    length < 1 ||
                    length > 10_000 ||
                    pending ||
                    control.isPending
                  }
                >
                  {pending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Send className="size-3" />
                  )}
                  {m.assistant_send()}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  )
}
