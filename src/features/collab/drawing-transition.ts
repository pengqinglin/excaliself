import { processSingleton } from "@/lib/process-singleton"

// Server functions and socket routes are separate bundles in the same process.
const transitions = processSingleton(
  "drawing-transitions",
  () => new Map<string, Promise<unknown>>(),
)

/** Serializes short topology changes from their DB write through Room cleanup. */
export async function withDrawingTransition<T>(
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = transitions.get(id) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  transitions.set(id, current)
  try {
    return await current
  } finally {
    if (transitions.get(id) === current) transitions.delete(id)
  }
}
