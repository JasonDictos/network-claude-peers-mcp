/**
 * Sticky-name lookup for a directory.
 *
 * A session's peer registers a second or three after Claude Code starts, and
 * for that window nothing in the roster matches it, so the status bar renders
 * every segment EXCEPT the peer name. Claude Code re-renders the status line
 * on activity rather than on a timer, so a session that starts and then sits
 * idle keeps the nameless bar until its next turn — which reads as "the name
 * sometimes doesn't appear".
 *
 * The name itself is knowable before any registration: name_bindings holds the
 * name bound to (host, cwd), and a relaunch in a known directory gets it back.
 * Looking that up lets the bar show the right name from the first render.
 */

import type { Database } from "bun:sqlite";

/**
 * The name bound to (host, cwd), or null when there is none — or when a live
 * peer already holds it.
 *
 * The `taken` guard matters: sticky names are only reused when free, so if a
 * co-resident session already holds this directory's name, the session being
 * rendered will be given a different one (`-2`). Returning the bound name
 * then would briefly show a name belonging to someone else, which is worse
 * than showing none.
 */
export function boundName(
  db: Database,
  host: string,
  cwd: string,
  taken: Iterable<string> = []
): string | null {
  const row = db
    .query("SELECT name FROM name_bindings WHERE host = ? AND cwd = ?")
    .get(host, cwd) as { name: string } | null;
  if (!row?.name) return null;
  const held = taken instanceof Set ? taken : new Set(taken);
  return held.has(row.name) ? null : row.name;
}
