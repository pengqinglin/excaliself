// A deterministic process fixture. It never calls a model or a service.
let prompt = ""
for await (const chunk of process.stdin) prompt += chunk
process.stdout.write(
  `${JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" })}\n`,
)
process.stdout.write(
  `${JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private reasoning must not reach chat" } })}\n`,
)
if (prompt === "WAIT") {
  setInterval(() => {}, 1000)
} else {
  const text = JSON.stringify({
    kind: "completed",
    body: JSON.stringify(process.argv.slice(2)),
  })
  process.stdout.write(
    `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`,
  )
}
