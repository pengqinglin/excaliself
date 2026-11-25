import { useQuery } from "@tanstack/react-query"
import { currentUserQueryOptions } from "@/features/account/queries"
import { getAssistantConnections } from "@/features/assistant/server"
import { m } from "@/paraglide/messages"

export function CodexConnectorSection() {
  const { data: user } = useQuery(currentUserQueryOptions())
  const connections = useQuery({
    queryKey: ["assistant-connections", user?.id],
    queryFn: () => getAssistantConnections(),
    enabled: !!user?.id,
    refetchInterval: 10_000,
  })
  return (
    <section className="rounded-xl border border-border/60 p-4">
      <h2 className="text-sm font-medium">{m.assistant_setup_title()}</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {m.assistant_setup_description()}
      </p>
      <p role="status" className="mt-3 text-xs">
        {connections.isPending
          ? m.assistant_loading()
          : connections.data?.length
            ? m.assistant_connected()
            : m.assistant_disconnected()}
      </p>
      <a
        href="https://excaliself.com/docs/ai-assistant/"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-block text-sm underline underline-offset-4"
      >
        {m.assistant_setup_guide()}
      </a>
    </section>
  )
}
