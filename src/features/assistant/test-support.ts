import { randomUUID } from "node:crypto"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import type { Db } from "@/db"
import * as schema from "@/db/schema"
import { accessTokens, drawings, users } from "@/db/schema"
import type { WorkerPrincipal } from "./types"

export async function createAssistantTestDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: "./drizzle" })
  return { db: db as Db, close: () => client.close() }
}

export async function seedAssistantTest(db: Db) {
  const prefix = randomUUID()
  const ownerId = `${prefix}-owner`
  const otherId = `${prefix}-other`
  const drawingId = `${prefix}-private`
  const teamId = `${prefix}-team`
  const tokenId = `${prefix}-token`
  await db.insert(users).values([
    { id: ownerId, email: `${ownerId}@example.com`, name: "Owner" },
    { id: otherId, email: `${otherId}@example.com`, name: "Other" },
  ])
  await db.insert(drawings).values([
    { id: drawingId, name: "Private", createdBy: ownerId },
    { id: teamId, name: "Team", space: "team", createdBy: ownerId },
  ])
  await db.insert(accessTokens).values({
    id: tokenId,
    userId: ownerId,
    name: "Codex",
    tokenHash: randomUUID(),
    start: "exs_test",
  })
  const principal: WorkerPrincipal = {
    userId: ownerId,
    credentialKind: "access_token",
    credentialId: tokenId,
    workerId: `${prefix}-worker`,
  }
  return { ownerId, otherId, drawingId, teamId, tokenId, principal }
}
