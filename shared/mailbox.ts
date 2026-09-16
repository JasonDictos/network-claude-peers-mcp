/**
 * Durable mailboxes.
 *
 * Mail is addressed to a mailbox — (name, host, cwd) — rather than to a peer
 * id, so it outlives the registration it was sent to. The weak point is the
 * name: a returning session does not always draw the same one. The sticky
 * name for a directory may be held by a co-resident session, so the session
 * lands on "repo-dudette" instead of "repo-dude" (or the reverse, once that
 * other session exits). When that happens the mailbox key changes and mail
 * addressed to the previous name is stranded: still undelivered, but nothing
 * will ever select it again.
 */

import type { Database } from "bun:sqlite";

export interface AdoptArgs {
  /** Host the registering peer belongs to. */
  host: string;
  /** Working directory of the registering peer. */
  cwd: string;
  /** Name the registering peer just got. */
  name: string;
  /** Names of live peers in the same (host, cwd) — their mail is off limits. */
  heldByLivePeers: string[];
}

/**
 * Hand a returning session the undelivered mail left for earlier names of the
 * same directory, and report how many messages moved.
 *
 * Scoped to one (host, cwd), and never takes mail addressed to a name a live
 * peer still holds — so two sessions sharing a directory keep separate
 * mailboxes, which is the whole point of the -dude/-dudette split.
 */
export function adoptOrphanedMail(db: Database, args: AdoptArgs): number {
  const { host, cwd, name, heldByLivePeers } = args;
  const exclude = heldByLivePeers.length
    ? `AND to_name NOT IN (${heldByLivePeers.map(() => "?").join(",")})`
    : "";
  const stmt = db.prepare(
    `UPDATE messages SET to_name = ?
       WHERE delivered = 0
         AND COALESCE(to_host, '') = ?
         AND COALESCE(to_cwd, '') = ?
         AND to_name != ''
         AND to_name != ?
         ${exclude}`
  );
  stmt.run(name, host, cwd, name, ...heldByLivePeers);
  // changes() reports the row count of the last INSERT/UPDATE/DELETE; a
  // SELECT in between does not reset it.
  const row = db.query("SELECT changes() AS n").get() as { n: number } | null;
  return row?.n ?? 0;
}
