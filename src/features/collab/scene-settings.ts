/** Only document settings; viewport, selection and theme are device-local. */
export type SceneSettings = {
  viewBackgroundColor: string
  gridSize: number
  gridStep: number
  gridModeEnabled: boolean
}

export const DEFAULT_SCENE_SETTINGS: SceneSettings = {
  viewBackgroundColor: "#ffffff",
  gridSize: 20,
  gridStep: 5,
  gridModeEnabled: false,
}

export function parseSceneSettings(value: unknown): SceneSettings | null {
  if (!value || typeof value !== "object") return null
  const settings = value as Record<string, unknown>
  if (
    typeof settings.viewBackgroundColor !== "string" ||
    !/^(?:transparent|#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8}))$/i.test(
      settings.viewBackgroundColor,
    )
  )
    return null
  if (typeof settings.gridModeEnabled !== "boolean") return null
  for (const key of ["gridSize", "gridStep"] as const)
    if (
      typeof settings[key] !== "number" ||
      !Number.isFinite(settings[key]) ||
      settings[key] <= 0 ||
      settings[key] > 10_000
    )
      return null
  return {
    viewBackgroundColor: settings.viewBackgroundColor,
    gridSize: settings.gridSize as number,
    gridStep: settings.gridStep as number,
    gridModeEnabled: settings.gridModeEnabled,
  }
}

export function storedSceneSettings(value: unknown): SceneSettings {
  return (
    parseSceneSettings({
      ...DEFAULT_SCENE_SETTINGS,
      ...(value && typeof value === "object" ? value : {}),
    }) ?? { ...DEFAULT_SCENE_SETTINGS }
  )
}

export type SettingsState = {
  appState: SceneSettings
  revision: number
  requestId?: number
  accepted?: boolean
}
export type SettingsUpdate = {
  appState: SceneSettings
  baseRevision: number
  requestId: number
}

/** Tracks only locally changed fields so reconnects don't overwrite remote settings. */
export function createSettingsSync(
  send: (update: SettingsUpdate) => boolean,
  apply: (settings: SceneSettings) => void,
) {
  let authoritative: SceneSettings | null = null
  let baseline: SceneSettings | null = null
  let revision = 0
  let nextRequest = 1
  const pending: Partial<SceneSettings> = {}
  let inFlight: { requestId: number; patch: Partial<SceneSettings> } | null =
    null

  const flush = () => {
    if (!authoritative || inFlight || Object.keys(pending).length === 0) return
    const requestId = nextRequest++
    const patch = { ...pending }
    if (
      send({
        appState: { ...authoritative, ...patch },
        baseRevision: revision,
        requestId,
      })
    )
      inFlight = { requestId, patch }
  }
  return {
    isReady: () => authoritative !== null,
    isSettled: () =>
      authoritative !== null && !inFlight && Object.keys(pending).length === 0,
    observe(raw: unknown) {
      const settings = parseSceneSettings(raw)
      if (!settings) return
      if (baseline) {
        for (const key of Object.keys(settings) as (keyof SceneSettings)[]) {
          if (settings[key] !== baseline[key])
            Object.assign(pending, { [key]: settings[key] })
        }
      }
      baseline = settings
      flush()
    },
    receive(state: SettingsState) {
      if (inFlight && inFlight.requestId === state.requestId) {
        if (state.accepted) {
          for (const key of Object.keys(
            inFlight.patch,
          ) as (keyof SceneSettings)[])
            if (pending[key] === inFlight.patch[key]) delete pending[key]
        }
        inFlight = null
      }
      if (!authoritative || state.revision >= revision) {
        authoritative = state.appState
        revision = state.revision
      }
      // Set baseline before apply: Excalidraw's synchronous onChange is not local intent.
      baseline = { ...authoritative, ...pending }
      apply(baseline)
      flush()
    },
    disconnect() {
      authoritative = null
      inFlight = null
      revision = 0
    },
  }
}
