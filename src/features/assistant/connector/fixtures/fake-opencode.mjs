let prompt = ""
for await (const chunk of process.stdin) prompt += chunk
const emit = (type, part = {}) =>
  console.log(JSON.stringify({ type, sessionID: "fixture-session", part }))
emit("step_start")
emit("reasoning", { text: "private reasoning must not reach chat" })
if (prompt === "WAIT") setInterval(() => {}, 1000)
else if (prompt === "INVALID") emit("text", { text: "not JSON" })
else if (prompt === "ERROR") emit("error", { message: "model unavailable" })
else {
  emit("text", {
    text: JSON.stringify({
      kind: "completed",
      body: JSON.stringify(process.argv.slice(2)),
    }),
  })
  emit("step_finish", { reason: "stop" })
}
