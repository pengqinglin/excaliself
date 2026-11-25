import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import { useQueryClient } from "@tanstack/react-query"
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react"
import { drawingQueryOptions, drawingsQueryOptions } from "./queries"
import { buildScenePayload } from "./scene"
import { prepareDrawingServerWriter } from "./server"
import type { WriterActivation } from "./writer-mode"

type Hold = () => {
  drained: Promise<void>
  release: (savePending?: boolean) => void
}
type Activation = Extract<WriterActivation, { status: "activated" }>
type DrawingWriter = { prepare: () => Promise<Activation>; preparing: boolean }

export const DrawingWriterContext = createContext<DrawingWriter | null>(null)
export const useDrawingWriter = () => {
  const value = useContext(DrawingWriterContext)
  if (!value)
    throw new Error("A drawing writer is available only inside its canvas")
  return value
}

/** Integration point for the assistant panel: one final snapshot before tasks may run. */
export function usePrepareDrawingWriter(options: {
  drawingId: string
  api: ExcalidrawImperativeAPI | null
  hold: Hold
  isRoom: boolean
  readOnly: boolean
  onConflict: () => void
  flushImages?: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const handlers = useRef(options)
  handlers.current = options
  const inFlight = useRef<Promise<Activation> | null>(null)
  const [preparing, setPreparing] = useState(false)
  const prepare = useCallback(() => {
    if (inFlight.current) return inFlight.current
    const { drawingId, api, hold, isRoom, readOnly, onConflict, flushImages } =
      handlers.current
    if (!api || readOnly)
      return Promise.reject(new Error("The drawing is not editable"))
    const held = hold()
    setPreparing(true)
    const run = async (): Promise<Activation> => {
      let activated = false
      let conflicted = false
      try {
        await held.drained
        if (isRoom) await flushImages?.()
        const drawing = queryClient.getQueryData(
          drawingQueryOptions(drawingId).queryKey,
        )
        if (!drawing) throw new Error("Drawing not found")
        const snapshot = isRoom
          ? undefined
          : buildScenePayload({
              elements: api.getSceneElementsIncludingDeleted(),
              appState: api.getAppState(),
              files: api.getFiles(),
            })
        const result = await prepareDrawingServerWriter({
          data: {
            id: drawingId,
            expectedRevision: drawing.sceneRevision,
            snapshot,
          },
        })
        if (result.status === "conflict") {
          conflicted = true
          onConflict()
          throw new Error(
            "The drawing changed in another tab. Reload the latest scene before retrying the handoff.",
          )
        }
        activated = true
        const mode = {
          serverManagedAt: result.serverManagedAt,
          sceneRevision: result.sceneRevision,
        }
        queryClient.setQueryData(
          drawingQueryOptions(drawingId).queryKey,
          (row) => row && { ...row, ...mode },
        )
        queryClient.setQueryData(drawingsQueryOptions().queryKey, (rows) =>
          rows?.map((row) =>
            row.id === drawingId ? { ...row, ...mode } : row,
          ),
        )
        return result
      } finally {
        held.release(!activated && !conflicted)
        inFlight.current = null
        setPreparing(false)
      }
    }
    const pending = run()
    inFlight.current = pending
    return pending
  }, [queryClient])
  return useMemo(() => ({ prepare, preparing }), [prepare, preparing])
}
