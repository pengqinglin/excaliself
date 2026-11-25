import { expect, test } from "vitest"
import {
  MAX_MESSAGE_LENGTH,
  messageBody,
  pageInput,
  parseInput,
} from "./schemas"
import { isTerminal, leaseIsLive } from "./state"

test("only completed, failed and cancelled tasks release the active-task slot", () => {
  expect(
    ["queued", "running", "awaiting_input"].map((status) =>
      isTerminal(status as "queued" | "running" | "awaiting_input"),
    ),
  ).toEqual([false, false, false])
  expect(isTerminal("completed")).toBe(true)
  expect(isTerminal("failed")).toBe(true)
  expect(isTerminal("cancelled")).toBe(true)
})

test("a lease expires at its exact deadline", () => {
  const deadline = new Date("2026-11-25T12:00:00Z")
  expect(leaseIsLive({ leaseExpiresAt: null }, deadline)).toBe(false)
  expect(leaseIsLive({ leaseExpiresAt: deadline }, deadline)).toBe(false)
  expect(
    leaseIsLive({ leaseExpiresAt: deadline }, new Date(deadline.getTime() - 1)),
  ).toBe(true)
})

test("message limits count Unicode code points after trimming", () => {
  expect(parseInput(messageBody, ` ${"🙂".repeat(MAX_MESSAGE_LENGTH)} `)).toBe(
    "🙂".repeat(MAX_MESSAGE_LENGTH),
  )
  expect(() => parseInput(messageBody, " \n ")).toThrow()
  expect(() =>
    parseInput(messageBody, "a".repeat(MAX_MESSAGE_LENGTH + 1)),
  ).toThrow()
  expect(() => parseInput(messageBody, "cannot store \u0000 here")).toThrow()
})

test("pagination is bounded and rejects invalid cursors", () => {
  expect(parseInput(pageInput, { conversationId: "c" })).toEqual({
    conversationId: "c",
    afterSequence: 0,
    limit: 50,
  })
  for (const input of [
    { limit: 101 },
    { limit: 0 },
    { afterSequence: -1 },
    { afterSequence: 0.5 },
  ])
    expect(() =>
      parseInput(pageInput, { conversationId: "c", ...input }),
    ).toThrow()
})
