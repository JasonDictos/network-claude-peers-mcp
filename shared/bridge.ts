/**
 * Pure logic for the OpenClaw bridge (openclaw-bridge.ts).
 *
 * Why a bridge exists at all: OpenClaw runs Claude Code one turn at a time,
 * with --print. Between turns there is no Claude Code process to push to, and
 * during a turn Claude Code does not deliver channel pushes in non-interactive
 * mode. So a peer message to an OpenClaw agent can only be read if the agent
 * happens to call check_messages. The bridge closes that gap: it holds the
 * agent's peer identity and mailbox permanently, and turns each inbound peer
 * message into an OpenClaw agent turn (`openclaw agent -m ...`), then sends the
 * agent's reply back to the sender.
 *
 * Everything here is side-effect free so it can be unit-tested.
 */

export interface InboundMessage {
  /** Broker message id. */
  id: number;
  from_id: string;
  /** Sender name at send time. */
  from_name: string;
  text: string;
  sent_at: string;
}

export interface SenderInfo {
  id: string;
  name: string;
  host: string | null;
  cwd: string;
}

/** A label for a sender as other peers see it: name, or name@host off-machine. */
export function senderLabel(name: string, host: string | null, selfHost: string): string {
  return host && host !== selfHost ? `${name}@${host}` : name;
}

/**
 * Whether a message must NOT start a turn.
 *
 * - From the bridge itself.
 * - From a peer running in the agent's own workspace on the agent's own host:
 *   that is one of the agent's own per-turn Claude Code sessions. Bridging its
 *   messages back in would let a turn wake itself, and a reply to it would
 *   start another turn -- a loop.
 */
export function isLoopback(
  sender: SenderInfo | null,
  fromId: string,
  self: { id: string; host: string; cwd: string }
): boolean {
  if (fromId === self.id) return true;
  if (!sender) return false;
  return (sender.host ?? self.host) === self.host && sender.cwd === self.cwd;
}

/**
 * The text an OpenClaw agent receives for one or more peer messages.
 *
 * The reply contract is spelled out because the agent otherwise tends to call
 * send_message itself, which would deliver its answer twice (once from its
 * per-turn session, once from the bridge).
 */
export function buildPrompt(
  batch: { label: string; text: string; sent_at: string }[],
  bridgeName: string
): string {
  const lines: string[] = [];
  const senders = [...new Set(batch.map((m) => m.label))];
  lines.push(
    batch.length === 1
      ? `[claude-peers] Peer message from ${batch[0]!.label}:`
      : `[claude-peers] ${batch.length} peer messages from ${senders.join(", ")}:`
  );
  for (const m of batch) {
    lines.push("");
    if (batch.length > 1) lines.push(`--- ${m.label} (${m.sent_at}) ---`);
    lines.push(m.text);
  }
  lines.push("");
  lines.push(
    `Your final reply in this turn is sent back automatically to ` +
      `${senders.length === 1 ? senders[0] : "each sender above"} as "${bridgeName}". ` +
      `Just answer in your normal reply; do not also call send_message to answer, ` +
      `or they will get it twice. Use send_message only to contact someone else.`
  );
  return lines.join("\n");
}

/**
 * The agent's reply text from `openclaw agent --json` output, or null if the
 * run did not produce one.
 *
 * Shape (OpenClaw 2026.9): { status: "ok", result: { payloads: [{ text }],
 * meta: { finalAssistantVisibleText } } }.
 */
export function extractReply(stdout: string): { ok: boolean; text: string | null; error?: string } {
  let doc: any;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, text: null, error: "openclaw produced no JSON" };
  }
  if (doc?.status && doc.status !== "ok") {
    return { ok: false, text: null, error: `openclaw status: ${doc.status}${doc.summary ? ` (${doc.summary})` : ""}` };
  }
  const payloads: unknown[] = Array.isArray(doc?.result?.payloads) ? doc.result.payloads : [];
  const fromPayloads = payloads
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .filter((t) => t.trim())
    .join("\n\n");
  const text = fromPayloads || doc?.result?.meta?.finalAssistantVisibleText || null;
  return { ok: true, text: typeof text === "string" && text.trim() ? text.trim() : null };
}

// --- Bridge marker ---
//
// OpenClaw keeps its Claude Code process alive between turns, so an agent's
// own per-turn claude-peers server can register first and hold the bridged
// name (and its mailbox) indefinitely. The bridge advertises itself in a
// marker file; a claude-peers server that finds itself holding the bridged
// name in the bridged workspace steps aside by renaming to <name>-turn.

import { existsSync, readFileSync as readMarkerFile } from "node:fs";
import { tmpdir as markerTmp } from "node:os";
import { join as markerJoin } from "node:path";

export interface BridgeMarker {
  name: string;
  cwd: string;
  host: string;
  pid: number;
}

/** Per-user marker path: one bridge per user is the supported setup. */
export function bridgeMarkerPath(uid = process.getuid?.() ?? 0): string {
  return markerJoin(process.env.XDG_RUNTIME_DIR || markerTmp(), `claude-peers-bridge-${uid}.json`);
}

/** The live bridge's marker, or null if absent, unreadable, or its pid is gone. */
export function readBridgeMarker(path = bridgeMarkerPath()): BridgeMarker | null {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readMarkerFile(path, "utf8")) as BridgeMarker;
    if (!m?.name || !m.cwd || !m.pid) return null;
    process.kill(m.pid, 0); // throws if the bridge is gone
    return m;
  } catch {
    return null;
  }
}

/**
 * The name a claude-peers server should rename itself to, or null to keep
 * its name: only when it holds the bridged name in the bridged workspace.
 */
export function stepAsideName(
  marker: BridgeMarker | null,
  me: { name: string; cwd: string; host: string }
): string | null {
  if (!marker) return null;
  if (me.name !== marker.name || me.cwd !== marker.cwd || me.host !== marker.host) return null;
  return `${marker.name}-turn`;
}
