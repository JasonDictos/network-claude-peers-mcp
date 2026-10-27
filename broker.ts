#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  SendMessageResponse,
  GroupDelivery,
  BoundNameRequest,
  BoundNameResponse,
  Peer,
  Message,
} from "./shared/types.ts";
import { generateName, childName, scopedName, repoBase, isRandomName } from "./shared/names.ts";
import { resolveTarget, resolveMailbox, sessionKey, sessionKeyOf } from "./shared/resolve.ts";
import { adoptOrphanedMail } from "./shared/mailbox.ts";
import { boundName } from "./shared/bindings.ts";
import {
  createGroupTable,
  groupMembers,
  expandMembers,
  groupCycle,
  listGroups,
  setGroup,
  deleteGroup,
  normalizeGroupName,
  groupNameError,
  membershipsOf,
  sameSession,
  isVisibleTo,
} from "./shared/groups.ts";
import type { Group } from "./shared/groups.ts";
import type { Mailbox } from "./shared/resolve.ts";
import { getRuntimeId } from "./shared/runtime.ts";
import { loadConfig, isLoopbackBind, isLoopbackAddress, machineName, writeMachineMarker } from "./shared/config.ts";
import { existsSync, unlinkSync, lstatSync } from "node:fs";
import { hostname } from "node:os";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const SOCKET_PATH = process.env.CLAUDE_PEERS_SOCK ?? `${process.env.HOME}/.claude-peers.sock`;
writeMachineMarker();
const MY_HOST = machineName();

// This broker's PID namespace. Peers registered from another runtime (e.g. a
// docker container) can't be liveness-checked via pid — heartbeats rule there.
const MY_RUNTIME = getRuntimeId();
const HEARTBEAT_STALE_MS = 60_000;

// Network mode: peers on other machines reach this broker over TCP. The API
// injects text into Claude sessions, so a network-facing bind MUST carry a
// shared token — refuse to start rather than expose an open injection point.
const { bind: BIND, token: TOKEN } = loadConfig();

// The commit this process was started on, reported by /health. `cli.ts update`
// compares it to the checkout to decide whether the broker needs a restart --
// inferring that from "did the pull move HEAD" left a broker on stale code
// after a local commit, or when it predated an earlier pull, while update
// reported "Already up to date".
// Its checkout dir rides along so update can tell "stale" from "a different
// checkout on this machine hosts the broker" -- those must not fight.
const BROKER_DIR = new URL("./", import.meta.url).pathname;
const BROKER_COMMIT = (() => {
  const r = Bun.spawnSync(["git", "-C", BROKER_DIR, "rev-parse", "HEAD"]);
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : null;
})();
if (!isLoopbackBind(BIND) && !TOKEN) {
  console.error(
    `[claude-peers broker] refusing to bind ${BIND} without a token.\n` +
      `  Run: bun cli.ts network-setup   (generates a token and prints remote config)`
  );
  process.exit(1);
}

// Refuse to double-start: SO_REUSEPORT on Linux would let two brokers share
// the port and load-balance requests between them (old + new code at once).
// The unix socket is checked too — inside a container the TCP port is a
// different namespace, but the socket is shared through the home mount.
async function brokerAnswers(url: string, opts: { unix?: string } = {}): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000), ...opts });
    return res.ok;
  } catch {
    return false;
  }
}
if (
  (await brokerAnswers("http://localhost/health", { unix: SOCKET_PATH })) ||
  (await brokerAnswers(`http://127.0.0.1:${PORT}/health`))
) {
  console.error(`[claude-peers broker] another broker is already running, exiting`);
  process.exit(0);
}
// No listener answered — remove a stale socket file so we can bind. Only
// ever delete an actual socket: a misconfigured CLAUDE_PEERS_SOCK pointing
// at a regular file must not cost someone that file.
if (existsSync(SOCKET_PATH)) {
  if (lstatSync(SOCKET_PATH).isSocket()) {
    unlinkSync(SOCKET_PATH);
  } else {
    console.error(
      `[claude-peers broker] ${SOCKET_PATH} exists and is not a socket — refusing to delete it, exiting`
    );
    process.exit(1);
  }
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    pid INTEGER NOT NULL,
    claude_pid INTEGER,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Sticky names: remembers which name belongs to which directory so a
// relaunched session gets its old name back. Keyed by (host, cwd) — the same
// path on two machines is two different sessions.
db.run(`
  CREATE TABLE IF NOT EXISTS name_bindings (
    host TEXT NOT NULL,
    cwd TEXT NOT NULL,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (host, cwd)
  )
`);

// Migrate a pre-network bindings table (PRIMARY KEY was cwd alone): SQLite
// can't alter a primary key, so rebuild and attribute existing rows to this
// machine.
{
  const cols = db.query("PRAGMA table_info(name_bindings)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "host")) {
    db.run(`
      CREATE TABLE name_bindings_new (
        host TEXT NOT NULL,
        cwd TEXT NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (host, cwd)
      )
    `);
    db.run(
      `INSERT INTO name_bindings_new (host, cwd, name, updated_at)
       SELECT ?, cwd, name, updated_at FROM name_bindings`,
      [MY_HOST]
    );
    db.run("DROP TABLE name_bindings");
    db.run("ALTER TABLE name_bindings_new RENAME TO name_bindings");
    console.error(`[claude-peers broker] migrated name bindings to (host, cwd)`);
  }
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    to_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Add columns introduced after the first release (the DB may predate them)
function ensureColumn(table: string, colDef: string) {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  } catch {
    // Column already exists
  }
}
ensureColumn("peers", "name TEXT NOT NULL DEFAULT ''");
ensureColumn("peers", "claude_pid INTEGER");
ensureColumn("peers", "claude_key TEXT");
ensureColumn("peers", "runtime TEXT");
ensureColumn("peers", "host TEXT");
ensureColumn("peers", "push_enabled INTEGER");

// Peer names are globally unique across every machine on the network — one
// broker hands them out, and a name alone is a complete address (no host
// qualifier needed). Enforced here so any regression fails loudly instead of
// silently making a name ambiguous. Unnamed legacy rows are exempt; they get
// names below.
try {
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_peers_name ON peers(name) WHERE name != ''");
} catch {
  // Pre-existing duplicates (from a much older build) — named rows get
  // deduped by normalizeAgentNames/nameUnnamedPeers below; skip the index
  // rather than refusing to start.
}
// Names denormalized onto messages so the log stays readable after peers die
ensureColumn("messages", "from_name TEXT NOT NULL DEFAULT ''");
ensureColumn("messages", "to_name TEXT NOT NULL DEFAULT ''");
// Durable mailbox: peer ids die with each registration, but (host, cwd, name)
// outlives them, so mail can wait for a session to come back
ensureColumn("messages", "to_host TEXT");
ensureColumn("messages", "to_cwd TEXT");
// The group a message was addressed to, when it was sent to one. Kept so the
// log can say which group a copy belongs to.
ensureColumn("messages", "group_name TEXT");

// Groups: one name addressing several peers (shared/groups.ts)
createGroupTable(db);

/**
 * Liveness: pid check (signal 0) when the peer shares our PID namespace,
 * heartbeat freshness when it doesn't (container peer seen from host or
 * vice versa — its pid means nothing here, possibly someone else's process).
 * Legacy rows without a runtime are treated as local.
 */
function isPeerAlive(p: Peer): boolean {
  // Another machine or another PID namespace: its pid means nothing here (it
  // may even belong to an unrelated local process), so trust heartbeats only.
  if ((p.host && p.host !== MY_HOST) || (p.runtime && p.runtime !== MY_RUNTIME)) {
    return Date.now() - Date.parse(p.last_seen) < HEARTBEAT_STALE_MS;
  }
  try {
    process.kill(p.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Clean up stale peers on startup
function cleanStalePeers() {
  const peers = db.query("SELECT * FROM peers").all() as Peer[];
  for (const peer of peers) {
    if (!isPeerAlive(peer)) {
      // Undelivered mail deliberately survives the peer: it is addressed to
      // the mailbox (host, cwd, name), so the session collects it when it
      // comes back. pruneMessages() ages it out eventually.
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    }
  }
}

cleanStalePeers();

/**
 * Age out messages. Undelivered mail waits a week for its session to return;
 * delivered mail is history for `cli.ts log` and is kept a month.
 */
const UNDELIVERED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function pruneMessages() {
  const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
  db.run("DELETE FROM messages WHERE delivered = 0 AND sent_at < ?", [iso(UNDELIVERED_TTL_MS)]);
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [iso(HISTORY_TTL_MS)]);
}

pruneMessages();

// Periodically clean stale peers and age out messages (every 30s)
setInterval(() => {
  cleanStalePeers();
  pruneMessages();
}, 30_000);

// Name peers that registered before the name column existed
function nameUnnamedPeers() {
  const unnamed = db.query("SELECT id FROM peers WHERE name = ''").all() as { id: string }[];
  for (const { id } of unnamed) {
    db.run("UPDATE peers SET name = ? WHERE id = ?", [generateName(takenNames()), id]);
  }
}

function takenNames(): Set<string> {
  const rows = db.query("SELECT name FROM peers WHERE name != ''").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function bindName(host: string, cwd: string, name: string) {
  db.run(
    `INSERT INTO name_bindings (host, cwd, name, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(host, cwd) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    [host, cwd, name, new Date().toISOString()]
  );
}

/** Legacy rows predate the host column; they were all local. */
function peerHost(p: Peer | { host: string | null }): string {
  return p.host ?? MY_HOST;
}

/** True if no other live peer of the same session registered earlier. */
function isPrimary(peer: Peer, live: Peer[]): boolean {
  const key = sessionKey(peer);
  if (key == null) return true;
  return !live.some(
    (p) =>
      p.id !== peer.id &&
      sessionKey(p) === key &&
      p.registered_at < peer.registered_at
  );
}

nameUnnamedPeers();

// Rename agent peers (same session as an earlier registration) to the
// suffix scheme — fixes groups that registered before this behavior existed
function normalizeAgentNames() {
  const all = db.query("SELECT * FROM peers").all() as Peer[];
  const alive = all.filter((p) => sessionKey(p) != null && isPeerAlive(p));
  const groups = new Map<string, Peer[]>();
  for (const p of alive) {
    const key = sessionKey(p)!;
    const group = groups.get(key) ?? [];
    group.push(p);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.registered_at.localeCompare(b.registered_at));
    const primary = group[0]!;
    const childPattern = new RegExp(`^${primary.name}-\\d+$`);
    for (const agent of group.slice(1)) {
      if (childPattern.test(agent.name)) continue;
      const name = childName(primary.name, takenNames());
      db.run("UPDATE peers SET name = ? WHERE id = ?", [name, agent.id]);
    }
  }
}

normalizeAgentNames();

// Seed bindings for live primaries whose directory has none yet, so names
// that predate stickiness become sticky from here on (existing bindings win)
function seedNameBindings() {
  const alive = (db.query("SELECT * FROM peers WHERE name != ''").all() as Peer[]).filter(
    isPeerAlive
  );
  const primaries = alive
    .filter((p) => isPrimary(p, alive))
    .sort((a, b) => a.registered_at.localeCompare(b.registered_at));
  for (const p of primaries) {
    db.run(
      "INSERT OR IGNORE INTO name_bindings (host, cwd, name, updated_at) VALUES (?, ?, ?, ?)",
      [peerHost(p), p.cwd, p.name, new Date().toISOString()]
    );
  }
}

seedNameBindings();

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, name, pid, claude_pid, claude_key, runtime, host, push_enabled, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, from_name, to_name, to_host, to_cwd, text, sent_at, group_name, delivered)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
`);

const selectRecentMessages = db.prepare(`
  SELECT * FROM (
    SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?
  ) ORDER BY id ASC
`);

// A session collects mail sent to its current registration *or* to its
// mailbox — mail queued while it was away, or addressed to it by name/path
// while offline.
const selectUndelivered = db.prepare(`
  SELECT * FROM messages
  WHERE delivered = 0
    AND ( to_id = ?1
          OR (to_name != '' AND to_name = ?2
              AND COALESCE(to_host, '') = ?3 AND COALESCE(to_cwd, '') = ?4) )
  ORDER BY sent_at ASC
`);

const countUndelivered = db.prepare(`
  SELECT COUNT(*) AS n FROM messages
  WHERE delivered = 0
    AND ( to_id = ?1
          OR (to_name != '' AND to_name = ?2
              AND COALESCE(to_host, '') = ?3 AND COALESCE(to_cwd, '') = ?4) )
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  const host = body.host ?? MY_HOST;

  // Remove any existing registration for this PID (re-registration). Scoped
  // to the host: pid numbers collide across machines, and dropping another
  // machine's peer because it shares a pid would silently unregister it.
  const existing = db
    .query("SELECT id FROM peers WHERE pid = ? AND COALESCE(host, ?) = ?")
    .get(body.pid, MY_HOST, host) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  const live = livePeers();
  const taken = new Set(live.map((p) => p.name));

  // Extra registrations from the same Claude process are subagent MCP
  // connections — name them as suffixed children of the session's primary
  let name: string;
  const myKey = sessionKeyOf(host, body.claude_key ?? null, body.claude_pid ?? null);
  const siblings = myKey ? live.filter((p) => sessionKey(p) === myKey) : [];
  if (siblings.length > 0) {
    const primary = siblings.reduce((a, b) => (a.registered_at <= b.registered_at ? a : b));
    name = childName(primary.name, taken);
  } else {
    // Sticky names: a relaunched session in a known directory gets its old
    // name back, unless another live peer holds it (second session there)
    const bound = db
      .query("SELECT name FROM name_bindings WHERE host = ? AND cwd = ?")
      .get(host, body.cwd) as { name: string } | null;
    if (bound && !taken.has(bound.name)) {
      name = bound.name;
    } else {
      name = scopedName(repoBase(body.cwd, body.git_root), taken);
      if (!bound) bindName(host, body.cwd, name);
    }
  }
  insertPeer.run(
    id,
    name,
    body.pid,
    body.claude_pid ?? null,
    body.claude_key ?? null,
    body.runtime ?? null,
    host,
    body.push_enabled === undefined ? null : body.push_enabled ? 1 : 0,
    body.cwd,
    body.git_root,
    body.tty,
    body.summary,
    now,
    now
  );

  // A returning session can draw a DIFFERENT name for the same directory: the
  // sticky name may be held by a co-resident session, so it lands on "repo-2"
  // instead of "repo" (or back on "repo" once that session exits).
  // The mailbox key is (name, host, cwd), so mail addressed to the previous
  // name is stranded — still delivered = 0, but nothing will ever select it
  // again, which quietly breaks the promise that mail outlives a session.
  // Adopt undelivered mail for this (host, cwd) whose addressee has no live
  // peer. Scoped to the directory, and skipped for subagent registrations, so
  // it can never take mail belonging to a sibling that is still running.
  if (siblings.length === 0) {
    const adopted = adoptOrphanedMail(db, {
      host,
      cwd: body.cwd,
      name,
      heldByLivePeers: live
        .filter((p) => peerHost(p) === host && p.cwd === body.cwd)
        .map((p) => p.name),
    });
    if (adopted > 0) {
      console.error(
        `[claude-peers broker] ${name} adopted ${adopted} stranded message(s) for ${host}:${body.cwd}`
      );
    }
  }

  return { id, name };
}

/** Returns false when the peer is unknown (pruned) — caller sends 404 so the
 *  MCP server re-registers instead of heartbeating into the void. */
function handleHeartbeat(body: HeartbeatRequest): boolean {
  const exists = db.query("SELECT id FROM peers WHERE id = ?").get(body.id);
  if (!exists) return false;
  updateLastSeen.run(new Date().toISOString(), body.id);
  return true;
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleSetName(body: { id: string; name: string }): {
  ok: boolean;
  error?: string;
  name?: string;
} {
  // Normalize to the same shape as generated names: lowercase, dash-separated
  const name = (body.name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!name || name.length > 64) {
    return { ok: false, error: "Name must be 1-64 characters" };
  }
  // Names are interpolated into agent-suffix RegExps — keep them regex-inert
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { ok: false, error: "Name may only contain letters, digits, and dashes" };
  }
  const peer = db.query("SELECT * FROM peers WHERE id = ?").get(body.id) as Peer | null;
  if (!peer) {
    return { ok: false, error: `Peer ${body.id} not found` };
  }
  const clash = livePeers().find((p) => p.id !== body.id && p.name.toLowerCase() === name);
  if (clash) {
    return {
      ok: false,
      // Names are global (one broker issues them), so say which machine holds it
      error: `Name "${name}" is already taken by peer ${clash.id} in ${peerHost(clash)}:${clash.cwd}`,
    };
  }
  db.run("UPDATE peers SET name = ? WHERE id = ?", [name, body.id]);

  // Sticky names: a renamed primary keeps its name across relaunches
  if (isPrimary(peer, livePeers())) {
    bindName(peerHost(peer), peer.cwd, name);
  }

  // Mail queued under the old name belongs to the same mailbox — retarget it
  // so a rename doesn't strand undelivered messages
  db.run(
    `UPDATE messages SET to_name = ?
     WHERE delivered = 0 AND to_name = ? AND COALESCE(to_host,'') = ? AND COALESCE(to_cwd,'') = ?`,
    [name, peer.name, peerHost(peer), peer.cwd]
  );

  // Renaming a session's primary carries its agent peers along:
  // old-name-N -> new-name-N
  const key = sessionKey(peer);
  if (key != null) {
    const childPattern = new RegExp(`^${peer.name}-(\\d+)$`);
    const agents = livePeers().filter(
      (p) => p.id !== body.id && sessionKey(p) === key && childPattern.test(p.name)
    );
    const taken = takenNames();
    for (const agent of agents) {
      const suffixed = `${name}-${agent.name.match(childPattern)![1]}`;
      const agentName = taken.has(suffixed) ? childName(name, taken) : suffixed;
      db.run("UPDATE peers SET name = ? WHERE id = ?", [agentName, agent.id]);
      taken.add(agentName);
    }
  }
  return { ok: true, name };
}

// All registered peers still alive (dead ones are pruned)
function livePeers(): Peer[] {
  return (selectAllPeers.all() as Peer[]).filter((p) => {
    if (isPeerAlive(p)) return true;
    deletePeer.run(p.id);
    return false;
  });
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers = livePeers();

  switch (body.scope) {
    case "directory":
      peers = peers.filter((p) => p.cwd === body.cwd);
      break;
    case "repo":
      if (body.git_root) {
        peers = peers.filter((p) => p.git_root === body.git_root);
      } else {
        // No git root, fall back to directory
        peers = peers.filter((p) => p.cwd === body.cwd);
      }
      break;
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  return peers;
}

function senderName(fromId: string): string {
  const row = db.query("SELECT name FROM peers WHERE id = ?").get(fromId) as
    | { name: string }
    | null;
  return row?.name ?? fromId;
}

/**
 * Deliver to one target: a peer id, name or path.
 *
 * `group` names the group this copy belongs to, when the delivery is one arm
 * of a fan-out — it rides along on the message so the log can show it.
 */
function deliverTo(
  fromId: string,
  target: string,
  text: string,
  group: string | null
): SendMessageResponse {
  // Resolve against live peers, excluding the sender (a path can match yourself)
  const peers = livePeers().filter((p) => p.id !== fromId);
  const resolution = resolveTarget(peers, target, process.env.HOME ?? "/");

  if (resolution.kind === "none") {
    // No live session — but the target may name a mailbox we know (a session
    // that has run in that directory before). Queue it there rather than
    // failing: the message is delivered when that session comes back.
    const boxes = db.query("SELECT host, cwd, name FROM name_bindings").all() as Mailbox[];
    const box = resolveMailbox(boxes, target, process.env.HOME ?? "/");
    if (box.kind === "match") {
      insertMessage.run(
        fromId,
        "",
        senderName(fromId),
        box.box.name,
        box.box.host,
        box.box.cwd,
        text,
        new Date().toISOString(),
        group
      );
      return {
        ok: true,
        queued_offline: true,
        to: { id: "", name: box.box.name },
      };
    }
    if (box.kind === "ambiguous") {
      return {
        ok: false,
        error:
          `"${target}" matches no live peer, and several known mailboxes ` +
          `(${box.candidates.map((b) => `${b.name} in ${b.host}:${b.cwd}`).join(", ")}) — ` +
          `address one by name.`,
      };
    }
    return {
      ok: false,
      error: `No peer matches "${target}". Live peers are listed in candidates.`,
      candidates: peers,
    };
  }
  if (resolution.kind === "ambiguous") {
    return {
      ok: false,
      error: `"${target}" matches ${resolution.candidates.length} peers — re-send to one of the candidates by name or ID.`,
      candidates: resolution.candidates,
    };
  }

  const peer = resolution.peer;
  // A live recipient that never loaded the channel can't be shown the
  // message — it waits for check_messages. Tell the sender, rather than
  // reporting a delivery that will not surface.
  const noPush = peer.push_enabled === 0;
  insertMessage.run(
    fromId,
    peer.id,
    senderName(fromId),
    peer.name,
    peerHost(peer),
    peer.cwd,
    text,
    new Date().toISOString(),
    group
  );
  return { ok: true, recipient_no_push: noPush || undefined, to: { id: peer.id, name: peer.name } };
}

/** A single delivery's outcome, without the whole peer roster riding along. */
function asDelivery(member: string, r: SendMessageResponse): GroupDelivery {
  return {
    member,
    ok: r.ok,
    error: r.error,
    queued_offline: r.queued_offline,
    recipient_no_push: r.recipient_no_push,
    to: r.to,
  };
}

/**
 * Fan a message out to every member of a group.
 *
 * One copy per member session, so a story reaches each of the three sessions
 * you meant — and only once, however many ways a member happens to be named.
 * The sender is skipped: it wrote the thing.
 */
function sendToGroup(
  fromId: string,
  name: string,
  members: string[],
  text: string
): SendMessageResponse {
  const peers = livePeers();
  const self = peers.find((p) => p.id === fromId) ?? null;
  const home = process.env.HOME ?? "/";
  const deliveries: GroupDelivery[] = [];
  const covered: Peer[] = [];

  for (const member of members) {
    const resolution = resolveTarget(peers, member, home);
    if (resolution.kind === "ambiguous") {
      deliveries.push({
        member,
        ok: false,
        error: `matches ${resolution.candidates.length} peers — name one in the group instead`,
      });
      continue;
    }
    if (resolution.kind === "none") {
      // Offline, or a path with no session right now: the single-target path
      // queues it in the mailbox if it knows one.
      const result = deliverTo(fromId, member, text, name);
      deliveries.push(
        result.candidates
          ? { member, ok: false, error: "no live session, and no mailbox known for it" }
          : asDelivery(member, result)
      );
      continue;
    }
    const peer = resolution.peer;
    if (self && sameSession(peer, self)) {
      deliveries.push({ member, ok: true, skipped: "self" });
      continue;
    }
    if (covered.some((c) => sameSession(c, peer))) {
      deliveries.push({ member, ok: true, skipped: "duplicate" });
      continue;
    }
    covered.push(peer);
    deliveries.push(asDelivery(member, deliverTo(fromId, peer.id, text, name)));
  }

  const sent = deliveries.filter((d) => d.ok && !d.skipped).length;
  return {
    ok: sent > 0,
    error:
      sent > 0
        ? undefined
        : `No member of "${name}" could be reached — see deliveries for each one.`,
    group: { name, deliveries },
  };
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  const target = body.to ?? body.to_id;
  if (!target) {
    return { ok: false, error: "Missing target: pass `to` (peer ID, name, or path)" };
  }

  // Nested groups are expanded here, so a member naming a group contributes
  // its members rather than a dead address.
  const members = expandMembers(listGroups(db), target);
  if (members) {
    // A live peer owns the name first. Group creation refuses a name a peer
    // already holds, but an `iam` rename afterwards can still collide, and
    // the peer you can see must be the one you reach.
    const live = resolveTarget(
      livePeers().filter((p) => p.id !== body.from_id),
      target,
      process.env.HOME ?? "/"
    );
    if (live.kind === "none") {
      return sendToGroup(body.from_id, normalizeGroupName(target), members, body.text);
    }
  }

  return deliverTo(body.from_id, target, body.text, null);
}

/** Groups, plus the ones a given peer belongs to (for broadcast scope). */
function handleGroups(body: { peer_id?: string }): {
  groups: Group[];
  memberships: string[];
} {
  const groups = listGroups(db);
  const peers = livePeers();
  const self = body.peer_id ? peers.find((p) => p.id === body.peer_id) : undefined;
  const memberships = self
    ? membershipsOf(groups, self, peers, process.env.HOME ?? "/")
    : [];
  return { groups, memberships };
}

function handleSetGroup(body: { name?: string; members?: string[] }): {
  ok: boolean;
  error?: string;
  group?: Group;
  /** The membership with nested groups expanded, when one was nested. */
  expanded?: string[];
  /** Members that match no live peer and no known mailbox — a likely typo. */
  unknown?: string[];
} {
  const name = (body.name ?? "").trim();
  const nameError = groupNameError(name);
  if (nameError) return { ok: false, error: nameError };

  const members = (body.members ?? []).map((m) => m.trim()).filter(Boolean);
  if (members.length === 0) {
    return { ok: false, error: `a group needs members: set-group ${name} <peer> <peer> ...` };
  }

  const key = normalizeGroupName(name);
  const peers = livePeers();
  const home = process.env.HOME ?? "/";

  // A group name is addressed exactly where a peer name is, so a collision
  // would make one of the two unreachable.
  if (peers.some((p) => p.name.toLowerCase() === key)) {
    return { ok: false, error: `"${key}" is a live peer's name — pick another group name` };
  }
  const boxes = db.query("SELECT host, cwd, name FROM name_bindings").all() as Mailbox[];
  if (boxes.some((b) => b.name.toLowerCase() === key)) {
    return {
      ok: false,
      error: `"${key}" is the sticky name of ${
        boxes.find((b) => b.name.toLowerCase() === key)!.cwd
      } — pick another group name`,
    };
  }

  // A member may name another group — it contributes that group's members at
  // send time. Only a cycle is refused, since it has no membership to expand
  // to and would otherwise be found at send time instead.
  const prospective = [
    ...listGroups(db).filter((g) => g.name !== key),
    { name: key, members },
  ];
  const cycle = groupCycle(prospective, key);
  if (cycle) {
    return {
      ok: false,
      error: `that would make "${key}" contain itself (${cycle.join(" -> ")})`,
    };
  }

  const unknown = members.filter(
    (m) =>
      groupMembers(db, m) === null &&
      resolveTarget(peers, m, home).kind === "none" &&
      resolveMailbox(boxes, m, home).kind === "none"
  );

  setGroup(db, key, members);
  const expanded = expandMembers(listGroups(db), key) ?? members;
  return {
    ok: true,
    group: { name: key, members },
    expanded: expanded.join("\u0000") === members.join("\u0000") ? undefined : expanded,
    unknown: unknown.length ? unknown : undefined,
  };
}

function handleDeleteGroup(body: { name?: string }): { ok: boolean; existed: boolean } {
  const name = (body.name ?? "").trim();
  if (!name) return { ok: false, existed: false };
  return { ok: true, existed: deleteGroup(db, name) };
}

/** Undelivered count for a peer — does NOT consume, unlike /poll-messages. */
function handlePending(body: { id: string }): { count: number } {
  const peer = db.query("SELECT * FROM peers WHERE id = ?").get(body.id) as Peer | null;
  if (!peer) return { count: 0 };
  const row = countUndelivered.get(
    peer.id,
    peer.name,
    peerHost(peer),
    peer.cwd
  ) as { n: number } | null;
  return { count: row?.n ?? 0 };
}

function handleLog(body: { limit?: number; after_id?: number; viewer_id?: string }): {
  messages: Message[];
} {
  const limit = Math.min(Math.max(body.limit ?? 50, 1), 500);
  const after = body.after_id ?? 0;

  // Unidentified caller (a shell, not a session) gets the whole feed — that
  // is the operator's monitoring view.
  const peer = body.viewer_id
    ? (db.query("SELECT * FROM peers WHERE id = ?").get(body.viewer_id) as Peer | null)
    : null;
  if (!peer) return { messages: selectRecentMessages.all(after, limit) as Message[] };

  // A peer sees only what it was party to, so a group's traffic stays in the
  // group. Over-read a bounded window and filter, so the limit counts
  // messages the caller can actually see rather than rows scanned.
  const viewer = { id: peer.id, name: peer.name, host: peerHost(peer), cwd: peer.cwd };
  const window = Math.min(Math.max(limit * 10, 500), 2000);
  const rows = selectRecentMessages.all(after, window) as Message[];
  return { messages: rows.filter((m) => isVisibleTo(m, viewer)).slice(-limit) };
}

/**
 * The sticky name for a directory, for a session whose peer has not registered
 * yet. The status bar asks for this when nothing in the roster matches it, so
 * the name shows from the first render instead of after the session's next turn.
 * Names held by live peers are withheld — see boundName().
 */
function handleBoundName(body: BoundNameRequest): BoundNameResponse {
  const host = body.host || MY_HOST;
  return { name: boundName(db, host, body.cwd, livePeers().map((p) => p.name)) };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse | null {
  const peer = db.query("SELECT * FROM peers WHERE id = ?").get(body.id) as Peer | null;
  if (!peer) return null;

  // Polling doubles as a heartbeat — container peers are liveness-checked
  // by last_seen alone
  updateLastSeen.run(new Date().toISOString(), body.id);

  const messages = selectUndelivered.all(
    peer.id,
    peer.name,
    peerHost(peer),
    peer.cwd
  ) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

/**
 * Requests from this machine (unix socket, or TCP from loopback) are trusted:
 * the socket is filesystem-gated and loopback means a local process. Anything
 * arriving over the network must present the shared token — without this,
 * binding to the network would hand anyone a text-injection channel into
 * every Claude session on it.
 */
function isAuthorized(req: Request, trusted: boolean): boolean {
  if (trusted) return true;
  if (!TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "");
  return presented.length > 0 && presented === TOKEN;
}

async function handleRequest(req: Request, trusted: boolean): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!isAuthorized(req, trusted)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (req.method !== "POST") {
    if (path === "/health") {
      return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length, commit: BROKER_COMMIT, dir: BROKER_DIR });
    }
    return new Response("claude-peers broker", { status: 200 });
  }

  try {
    const body = await req.json();

    switch (path) {
      case "/register":
        return Response.json(handleRegister(body as RegisterRequest));
      case "/heartbeat":
        if (!handleHeartbeat(body as HeartbeatRequest)) {
          return Response.json({ error: "unknown peer" }, { status: 404 });
        }
        return Response.json({ ok: true });
      case "/set-summary":
        handleSetSummary(body as SetSummaryRequest);
        return Response.json({ ok: true });
      case "/set-name":
        return Response.json(handleSetName(body as { id: string; name: string }));
      case "/list-peers":
        return Response.json(handleListPeers(body as ListPeersRequest));
      case "/send-message":
        return Response.json(handleSendMessage(body as SendMessageRequest));
      case "/poll-messages": {
        const result = handlePollMessages(body as PollMessagesRequest);
        if (result === null) {
          return Response.json({ error: "unknown peer" }, { status: 404 });
        }
        return Response.json(result);
      }
      case "/pending":
        return Response.json(handlePending(body as { id: string }));
      case "/bound-name":
        return Response.json(handleBoundName(body as BoundNameRequest));
      case "/log":
        return Response.json(
          handleLog(body as { limit?: number; after_id?: number; viewer_id?: string })
        );
      case "/groups":
        return Response.json(handleGroups(body as { peer_id?: string }));
      case "/set-group":
        return Response.json(handleSetGroup(body as { name?: string; members?: string[] }));
      case "/delete-group":
        return Response.json(handleDeleteGroup(body as { name?: string }));
      case "/unregister":
        handleUnregister(body as { id: string });
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

/**
 * Retire names the broker no longer issues: the old `-dude` / `-dudette`
 * tokens and the adjective-noun pool, both of which predate directory names
 * and keep coming back through name_bindings. An `iam` rename is left alone.
 *
 * Runs after the prepared statements exist, since the rename path uses them.
 * Renaming through handleSetName carries the mailbox and agent peers along,
 * so a live session is renamed without stranding its mail.
 */
function retireNames() {
  const retired = (name: string) => /-(dude|dudette)(-\d+)?$/.test(name) || isRandomName(name);
  const alive = (db.query("SELECT * FROM peers WHERE name != ''").all() as Peer[]).filter(
    isPeerAlive
  );
  // Primaries only — an agent's name follows its primary's
  for (const p of alive.filter((p) => isPrimary(p, alive) && retired(p.name))) {
    const want = scopedName(repoBase(p.cwd, p.git_root), takenNames());
    const r = handleSetName({ id: p.id, name: want });
    if (!r.ok) console.error(`[broker] could not rename ${p.name}: ${r.error}`);
  }
  // Bindings for directories with no live peer have nobody to rename; drop
  // them so the next session there draws a current name
  const bindings = db
    .query("SELECT host, cwd, name FROM name_bindings")
    .all() as { host: string; cwd: string; name: string }[];
  for (const b of bindings.filter((b) => retired(b.name))) {
    db.run("DELETE FROM name_bindings WHERE host = ? AND cwd = ? AND name = ?", [
      b.host,
      b.cwd,
      b.name,
    ]);
  }
}

retireNames();

// TCP: host-local clients, and peers on other machines when BIND is a
// network address. Loopback callers are trusted; remote callers need the
// token (see isAuthorized).
const tcpServer: import("bun").Server<undefined> = Bun.serve({
  port: PORT,
  hostname: BIND,
  reusePort: false,
  fetch: (req): Promise<Response> =>
    handleRequest(req, isLoopbackAddress(tcpServer.requestIP(req)?.address)),
});

// Unix socket: rides the home bind-mount into docker containers, where the
// host's TCP loopback is unreachable
Bun.serve({
  unix: SOCKET_PATH,
  fetch: (req) => handleRequest(req, true),
});

function cleanupSocket() {
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // Already gone
  }
}
process.on("SIGTERM", () => {
  cleanupSocket();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanupSocket();
  process.exit(0);
});

console.error(
  `[claude-peers broker] listening on ${BIND}:${PORT} and ${SOCKET_PATH} ` +
    `(host: ${MY_HOST}, network auth: ${TOKEN ? "token" : "loopback only"}, db: ${DB_PATH})`
);
