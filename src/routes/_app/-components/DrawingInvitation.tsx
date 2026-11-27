import {
  Copy,
  Loader2,
  Pause,
  Play,
  Power,
  RotateCw,
  Sparkles,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  controlDrawingInvitation,
  createDrawingInvitation,
} from "@/features/assistant/server"
import { useDrawingWriter } from "@/features/drawings/use-drawing-writer"
import { m } from "@/paraglide/messages"
import { getLocale } from "@/paraglide/runtime"

type Invitation = {
  id: string
  expiresAt: Date
  lastSeenAt: Date | null
  clientName: string | null
  control: "running" | "paused"
}

export function DrawingInvitation({
  conversationId,
  invitation,
  paused,
  workState,
  open,
  onOpen,
  invalidate,
}: {
  conversationId: string
  invitation: Invitation | null | undefined
  paused: boolean
  workState: string | null
  open: boolean
  onOpen: () => void
  invalidate: () => Promise<unknown>
}) {
  const writer = useDrawingWriter()
  // Credentials live only in this component, never in a query or mutation cache.
  const [secret, setSecret] = useState<{ id: string; markdown: string } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const started = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Query notifications may arrive after invalidate() resolves. Keep the local
  // result through that delay, but expose it only for the current grant.
  const currentSecret = secret?.id === invitation?.id ? secret : null

  const enable = async () => {
    if (busy || !conversationId) return
    setBusy(true)
    setFailed(false)
    setCopied(false)
    setSecret(null)
    try {
      const { barrier } = await writer.prepare()
      const result = await createDrawingInvitation({
        data: { conversationId, barrier },
      })
      await invalidate()
      if (mounted.current) {
        const origin = window.location.origin
        setSecret({
          id: result.id,
          markdown: m.assistant_invite_markdown({
            drawingUrl: `${origin}/draw/${encodeURIComponent(result.drawingId)}`,
            drawingId: result.drawingId,
            mcpUrl: `${origin}/api/mcp`,
            token: result.token,
            expiresAt: new Intl.DateTimeFormat(getLocale(), {
              dateStyle: "medium",
              timeStyle: "long",
            }).format(new Date(result.expiresAt)),
          }),
        })
      }
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      await invalidate()
      if (mounted.current) setBusy(false)
    }
  }
  useEffect(() => {
    if (
      open &&
      conversationId &&
      invitation !== undefined &&
      !started.current
    ) {
      started.current = true
      if (!invitation) void enable()
    }
  })
  const control = async (command: "pause" | "resume" | "revoke") => {
    if (!invitation || busy) return
    setBusy(true)
    setFailed(false)
    try {
      const barrier =
        command === "resume" ? (await writer.prepare()).barrier : undefined
      await controlDrawingInvitation({
        data: { conversationId, grantId: invitation.id, command, barrier },
      })
      if (command === "revoke") {
        setSecret(null)
        setCopied(false)
      }
    } catch {
      setFailed(true)
    } finally {
      await invalidate()
      setBusy(false)
    }
  }
  const connected =
    !!invitation?.lastSeenAt &&
    Date.now() - new Date(invitation.lastSeenAt).getTime() < 45_000
  const status = !invitation
    ? m.assistant_invite_off()
    : paused
      ? m.assistant_invite_human()
      : connected
        ? m.assistant_invite_connected()
        : m.assistant_invite_waiting()
  const actions = invitation && (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => void control(paused ? "resume" : "pause")}
    >
      {busy ? (
        <Loader2 className="size-3 animate-spin" />
      ) : paused ? (
        <Play className="size-3" />
      ) : (
        <Pause className="size-3" />
      )}
      {paused ? m.assistant_invite_resume() : m.assistant_invite_pause()}
    </Button>
  )
  if (!open)
    return invitation ? (
      <div className="absolute bottom-12 left-3 z-30 flex max-w-[calc(100%_-_1.5rem)] flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow-sm">
        <Button size="sm" onClick={onOpen} title={status}>
          <Sparkles className="size-3" />
          {m.assistant_title()}
        </Button>
        <span role="status" className="text-xs">
          {status}
        </span>
        {actions}
        {failed && (
          <span role="alert" className="text-xs text-destructive">
            {m.assistant_action_failed()}
          </span>
        )}
      </div>
    ) : null
  return (
    <div className="shrink-0 space-y-2 border-b border-border/60 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="font-medium">
          {busy ? m.assistant_invite_syncing() : status}
        </p>
        {invitation ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void control("revoke")}
          >
            <Power className="size-3" />
            {m.assistant_invite_disable()}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !conversationId}
            onClick={() => void enable()}
          >
            {m.assistant_invite_enable()}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground">{m.assistant_invite_intro()}</p>
      {invitation && workState && <p className="font-medium">{workState}</p>}
      {invitation && (
        <>
          <p className="text-muted-foreground">
            {m.assistant_invite_expiry({
              expiresAt: new Intl.DateTimeFormat(getLocale(), {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(invitation.expiresAt)),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            {currentSecret && (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(currentSecret.markdown)
                    .then(
                      () => setCopied(true),
                      () => setFailed(true),
                    )
                }}
              >
                <Copy className="size-3" />
                {copied
                  ? m.assistant_invite_copied()
                  : m.assistant_invite_copy()}
              </Button>
            )}
            {actions}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void enable()}
            >
              <RotateCw className="size-3" />
              {m.assistant_invite_regenerate()}
            </Button>
          </div>
          {!currentSecret && (
            <p className="text-muted-foreground">{m.assistant_invite_once()}</p>
          )}
          <p className="text-muted-foreground">
            {m.assistant_invite_continue()}
          </p>
          {currentSecret && (
            <details>
              <summary className="cursor-pointer">
                {m.assistant_invite_preview()}
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-[11px]">
                {currentSecret.markdown}
              </pre>
            </details>
          )}
        </>
      )}
      {failed && (
        <p role="alert" className="text-destructive">
          {m.assistant_action_failed()}
        </p>
      )}
    </div>
  )
}
