/**
 * Runtime identity helpers for containers.
 *
 * PIDs are only meaningful within one PID namespace: a peer inside a docker
 * container has a pid the host broker can't signal-0, and pid numbers collide
 * across namespaces. Two keys solve this:
 *
 * - runtime id: identifies the namespace (host or a specific container) so
 *   the broker knows when a pid liveness check is valid.
 * - claude key: pid + process start time, unique across namespaces, used to
 *   group a session's subagent MCP connections.
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/** Fields of /proc/<pid>/stat after the (comm) — comm may contain spaces. */
function statFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    return stat.slice(close + 1).trim().split(/\s+/);
  } catch {
    return null;
  }
}

/**
 * Process start time in clock ticks since boot (stat field 22), or null.
 * Without /proc (macOS) callers fall back to a constant "0" suffix — runtime
 * and session keys then degrade to plain pid matching, which is fine there:
 * the cross-namespace collision this guards against is a Linux-container
 * scenario.
 */
export function getStartTime(pid: number): string | null {
  // After (comm): state=f3 ... starttime=f22 -> index 19
  return statFields(pid)?.[19] ?? null;
}

/** Parent pid from /proc (stat field 4), or null. */
export function getParentPid(pid: number): number | null {
  const ppid = statFields(pid)?.[1];
  const n = ppid ? parseInt(ppid, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Session grouping key for a Claude process: unique across PID namespaces
 * (same pid number in host + container have different start times).
 */
export function claudeKey(pid: number): string {
  return `${pid}:${getStartTime(pid) ?? "0"}`;
}

/** Argv of a process, or null if it's gone / unreadable. */
export function readCmdline(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Whether a Claude Code process loaded *this* MCP server as a channel.
 *
 * Without a channel entry in --channels /
 * --dangerously-load-development-channels, the server still registers and its
 * tools work, but Claude Code has no listener for pushed events and drops
 * them silently — inbound peer messages never reach the session. Detecting it
 * turns that silence into something we can warn about.
 *
 * Which entry authorizes us depends on how we were loaded, and the two are
 * NOT interchangeable. Claude Code sets CLAUDE_PLUGIN_ROOT only for a server
 * a plugin supplies, and authorizes it as `plugin:<plugin>@<marketplace>`; a
 * server configured in .claude.json / .mcp.json is authorized as
 * `server:<name>`. Accepting either form regardless of how we were loaded is
 * a silent-data-loss bug: register the same server name in both places and
 * the config copy wins the connection, sees the plugin's entry in argv,
 * reports push working, drains the broker — and Claude Code discards every
 * notification with "server <name> not in --channels list for this session".
 */
export function channelEnabled(
  claudePid: number,
  serverName = "claude-peers",
  pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
): boolean | null {
  const argv = readCmdline(claudePid);
  if (!argv) return null; // can't tell
  // A plugin's own name is the last segment of its root, and it is the name
  // the channel entry carries — not necessarily the MCP server's name.
  const entry = pluginRoot
    ? new RegExp(`^plugin:${escapeRe(pluginRoot.replace(/\/+$/, "").split("/").pop() ?? "")}(@|$)`)
    : new RegExp(`^server:${escapeRe(serverName)}$`);
  return argv.some((a) => entry.test(a));
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Identifies this PID namespace: hostname + start time of pid 1 (the boot for
 * a host, the container init for a container). Peers with a different runtime
 * id can't be pid-checked and are judged by heartbeat freshness instead.
 */
export function getRuntimeId(): string {
  return `${hostname()}:${getStartTime(1) ?? "0"}`;
}
