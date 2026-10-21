/**
 * Peer groups: a name that stands for several peers.
 *
 * A group is an address, not a peer — it has no id, no mailbox and no
 * identity of its own. Sending to one fans the message out to each member,
 * which is how you get three sessions onto the same page in one go.
 *
 * Membership also scopes two things that were network-wide before: a
 * broadcast from a session in a group stays inside it, and the message log
 * shows a peer only the messages it was party to, so a group's traffic is
 * not readable by every other session on the network.
 */

import type { Database } from "bun:sqlite";
import type { Peer } from "./types.ts";
import { sessionKey, resolveTarget } from "./resolve.ts";

/** Subcommand words — a group named for one could never be addressed. */
const RESERVED = ["rm", "ls"];

/**
 * Why `name` cannot be a group, or null if it can.
 *
 * Group names share the namespace peers are addressed in, so they are held
 * to the same shape as a peer name: no whitespace to split the command line,
 * and none of the punctuation that means "path", "host:" or "name@host".
 */
export function groupNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "a group needs a name";
  if (!/^[a-zA-Z0-9-]+$/.test(trimmed)) {
    return `"${name}" is not a usable group name — letters, digits and hyphens only`;
  }
  if (RESERVED.includes(trimmed.toLowerCase())) {
    return `"${trimmed}" is a subcommand, so a group by that name could never be addressed`;
  }
  return null;
}

/** Storage form of a group name: addressing is case-insensitive. */
export function normalizeGroupName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * One peer per session, keeping the first of each.
 *
 * Two members can name the same session — by name and by path, or a session
 * and one of its agents — and a story should arrive once, not twice. First
 * wins so the member the user listed first is the one that gets it.
 */
export function dedupeSessions(peers: Peer[]): Peer[] {
  const seen = new Set<string>();
  const out: Peer[] = [];
  for (const p of peers) {
    const key = sessionKey(p) ?? `id:${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export type BroadcastScope =
  | { kind: "all" }
  | { kind: "group"; name: string }
  | { kind: "ambiguous"; groups: string[] };

/**
 * Who a bare `broadcast` reaches: everyone, or the sender's group.
 *
 * Being in a group makes it the default audience — that is the point of
 * having one. Two groups have no sensible default, so the sender picks.
 */
export function broadcastScope(memberships: string[], explicit: string | null): BroadcastScope {
  if (explicit) return { kind: "group", name: explicit };
  if (memberships.length === 0) return { kind: "all" };
  if (memberships.length === 1) return { kind: "group", name: memberships[0]! };
  return { kind: "ambiguous", groups: memberships };
}

/** The addressing fields of a message, as stored. */
export interface MessageParty {
  from_id: string;
  from_name: string;
  to_id: string;
  to_name: string;
  to_host: string | null;
  to_cwd: string | null;
}

/** A peer asking to read the log. */
export interface Viewer {
  id: string;
  name: string;
  host: string;
  cwd: string;
}

/**
 * Whether a peer was party to a message, as sender or recipient.
 *
 * The log used to hand every message's full text to whoever asked, which
 * makes a group pointless. Identity is matched by mailbox as well as by peer
 * id: ids are per-registration, so a session that has restarted still owns
 * what it sent and received under its old one.
 */
export function isVisibleTo(m: MessageParty, v: Viewer): boolean {
  if (m.from_id === v.id || (m.from_name !== "" && m.from_name === v.name)) return true;
  if (m.to_id !== "" && m.to_id === v.id) return true;
  return (
    m.to_name !== "" &&
    m.to_name === v.name &&
    (m.to_host ?? "") === v.host &&
    (m.to_cwd ?? "") === v.cwd
  );
}

// --- Storage ---
//
// Groups live in the broker's database next to the sticky names, not in a
// per-machine config file: one broker serves every machine, so a group made
// in any session is addressable from all of them.

export interface Group {
  name: string;
  /** Member targets as typed — a name, a path, or "host:path". */
  members: string[];
}

export function createGroupTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS peer_groups (
      name TEXT NOT NULL,
      member TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (name, member)
    )
  `);
}

/** Create a group or replace its membership wholesale. */
export function setGroup(db: Database, name: string, members: string[]): void {
  const key = normalizeGroupName(name);
  db.transaction(() => {
    db.run("DELETE FROM peer_groups WHERE name = ?", [key]);
    members.forEach((member, i) => {
      db.run("INSERT OR REPLACE INTO peer_groups (name, member, position) VALUES (?, ?, ?)", [
        key,
        member,
        i,
      ]);
    });
  })();
}

/** A group's members in order, or null if there is no such group. */
export function groupMembers(db: Database, name: string): string[] | null {
  const rows = db
    .query("SELECT member FROM peer_groups WHERE name = ? ORDER BY position")
    .all(normalizeGroupName(name)) as { member: string }[];
  return rows.length ? rows.map((r) => r.member) : null;
}

export function listGroups(db: Database): Group[] {
  const rows = db
    .query("SELECT name, member FROM peer_groups ORDER BY name, position")
    .all() as { name: string; member: string }[];
  const groups: Group[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.name === row.name) last.members.push(row.member);
    else groups.push({ name: row.name, members: [row.member] });
  }
  return groups;
}

/** Delete a group, reporting whether it existed. */
export function deleteGroup(db: Database, name: string): boolean {
  db.run("DELETE FROM peer_groups WHERE name = ?", [normalizeGroupName(name)]);
  const row = db.query("SELECT changes() AS n").get() as { n: number } | null;
  return (row?.n ?? 0) > 0;
}

/** Same Claude Code session — an agent peer counts as its primary. */
export function sameSession(a: Peer, b: Peer): boolean {
  const ka = sessionKey(a);
  const kb = sessionKey(b);
  return ka !== null && kb !== null ? ka === kb : a.id === b.id;
}

/**
 * The groups a peer belongs to.
 *
 * Membership is stored as the target the user typed, so it is resolved the
 * same way a send is — a group listing "~/archiver" covers whatever session
 * is working there, which is the point of addressing by path.
 */
export function membershipsOf(groups: Group[], peer: Peer, peers: Peer[], home: string): string[] {
  return groups
    .filter((g) =>
      g.members.some((member) => {
        const r = resolveTarget(peers, member, home);
        if (r.kind === "match") return sameSession(r.peer, peer);
        if (r.kind === "ambiguous") return r.candidates.some((c) => sameSession(c, peer));
        return false;
      })
    )
    .map((g) => g.name);
}
