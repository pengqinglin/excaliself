import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { currentUserQueryOptions } from "@/features/account/queries"
import { getAssistantConnections } from "@/features/assistant/server"
import { m } from "@/paraglide/messages"

export function AssistantConnectorSection() {
  const [origin, setOrigin] = useState("")
  useEffect(() => setOrigin(window.location.origin), [])
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
      {!!connections.data?.length && (
        <ul className="mt-2 space-y-1 text-sm">
          {connections.data.map((connection) => (
            <li key={connection.workerId} className="break-words">
              {connection.name}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs font-medium">{m.assistant_setup_endpoint()}</p>
      <code className="mt-1 block select-all break-all rounded bg-muted p-2 text-xs">
        {origin ? `${origin}/api/mcp` : "/api/mcp"}
      </code>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {m.assistant_setup_steps()}
      </p>
      {(["OpenCode", "Codex"] as const).map((engine) => (
        <details key={engine} className="mt-3 rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {m.assistant_setup_command({ name: engine })}
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs leading-relaxed">
            {`export EXCALISELF_URL='${origin}'\nread -rs EXCALISELF_TOKEN\nexport EXCALISELF_TOKEN\npnpm assistant:${engine.toLowerCase()}`}
          </pre>
        </details>
      ))}
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
