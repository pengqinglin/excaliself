import { expect, test } from "vitest"
import { parseClientMessage, parseServerMessage } from "./protocol"
import {
  createSettingsSync,
  DEFAULT_SCENE_SETTINGS,
  type SceneSettings,
  type SettingsUpdate,
} from "./scene-settings"

const base = DEFAULT_SCENE_SETTINGS
function sync() {
  const sent: SettingsUpdate[] = []
  const applied: SceneSettings[] = []
  const state = createSettingsSync(
    (update) => {
      sent.push(update)
      return true
    },
    (settings) => {
      applied.push(settings)
      state.observe(settings)
    },
  )
  state.observe(base)
  return { state, sent, applied }
}

test("settings frames reject unsafe revisions, colors and local UI state", () => {
  const raw = (payload: unknown) =>
    JSON.stringify({ type: "SCENE_STATE", payload })
  for (const appState of [
    { ...base, viewBackgroundColor: "url(https://example.com)" },
    { ...base, gridSize: -1 },
    { ...base, gridStep: 1e9 },
  ])
    expect(
      parseClientMessage(raw({ appState, baseRevision: 0, requestId: 1 })),
    ).toBeNull()
  expect(
    parseClientMessage(raw({ appState: base, baseRevision: -1, requestId: 1 })),
  ).toBeNull()
  expect(parseServerMessage(raw({ appState: base, revision: -1 }))).toBeNull()
  expect(
    parseClientMessage(
      raw({
        appState: { ...base, scrollX: 100, theme: "dark" },
        baseRevision: 0,
        requestId: 1,
      }),
    ),
  ).toEqual({
    type: "SCENE_STATE",
    payload: { appState: base, baseRevision: 0, requestId: 1 },
  })
})

test("initial and remote settings apply without echoing", () => {
  const { state, sent, applied } = sync()
  state.receive({ appState: base, revision: 0 })
  state.receive({ appState: { ...base, gridModeEnabled: true }, revision: 1 })
  expect(applied.at(-1)?.gridModeEnabled).toBe(true)
  expect(sent).toEqual([])
})

test("local updates wait for acknowledgement and preserve edits made in flight", () => {
  const { state, sent, applied } = sync()
  state.receive({ appState: base, revision: 0 })
  state.observe({ ...base, viewBackgroundColor: "#aaaaaa" })
  state.observe({ ...base, viewBackgroundColor: "#bbbbbb" })
  expect(sent).toHaveLength(1)
  state.receive({
    appState: sent[0].appState,
    revision: 1,
    requestId: 1,
    accepted: true,
  })
  expect(sent).toHaveLength(2)
  expect(sent[1]).toMatchObject({
    baseRevision: 1,
    appState: { viewBackgroundColor: "#bbbbbb" },
  })
  state.receive({
    appState: sent[1].appState,
    revision: 2,
    requestId: 2,
    accepted: true,
  })
  expect(applied.at(-1)?.viewBackgroundColor).toBe("#bbbbbb")
  expect(sent).toHaveLength(2)
})

test("a CAS conflict rebases local changed fields without overwriting a teammate's grid", () => {
  const { state, sent } = sync()
  state.receive({ appState: base, revision: 0 })
  state.observe({ ...base, viewBackgroundColor: "#aaaaaa" })
  state.receive({
    appState: { ...base, gridModeEnabled: true },
    revision: 1,
    requestId: 1,
    accepted: false,
  })
  expect(sent[1]).toMatchObject({
    baseRevision: 1,
    appState: { viewBackgroundColor: "#aaaaaa", gridModeEnabled: true },
  })
})

test("offline local changes survive reconnect but old unmodified settings do not overwrite remote changes", () => {
  const { state, sent, applied } = sync()
  state.receive({ appState: base, revision: 4 })
  state.disconnect()
  state.observe({ ...base, viewBackgroundColor: "#cccccc" })
  state.receive({ appState: { ...base, gridSize: 40 }, revision: 0 })
  expect(sent.at(-1)).toMatchObject({
    baseRevision: 0,
    appState: { gridSize: 40, viewBackgroundColor: "#cccccc" },
  })
  expect(applied.at(-1)).toMatchObject({
    gridSize: 40,
    viewBackgroundColor: "#cccccc",
  })
})
