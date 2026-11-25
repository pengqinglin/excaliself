import { createHash } from "node:crypto"

/** An admission tag; never sent on the wire or accepted as authentication. */
export const shareKey = (token: string) =>
  createHash("sha256").update(token).digest("hex")
