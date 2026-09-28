#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  SendMessageResponse,
  Message,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import { brokerFetch, IS_REMOTE, BROKER_URL } from "./shared/client.ts";
import { claudeKey, getRuntimeId, getParentPid, channelEnabled, argvScrubbed } from "./shared/runtime.ts";
import { hostname } from "node:os";
import { machineName, writeMachineMarker } from "./shared/config.ts";
import { readBridgeMarker, stepAsideName } from "./shared/bridge.ts";

// --- Configuration ---

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Broker communication ---

async function isBrokerAlive(): Promise<boolean> {
  try {
    await brokerFetch("/health", undefined, 2000);
    return true;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log(IS_REMOTE ? `Using remote broker ${BROKER_URL}` : "Broker already running");
    return;
  }

  // A remote broker is someone else's to run — never spawn a local one that
  // would silently split the network in two.
  if (IS_REMOTE) {
    throw new Error(`Remote broker ${BROKER_URL} is unreachable (check host, port, token)`);
  }

  log("Starting broker daemon...");
  // process.execPath, not "bun": bun is commonly installed to ~/.bun/bin,
  // which isn't on the PATH Claude Code hands its MCP servers. We're already
  // running under bun, so its own binary is the one interpreter we know exists.
  const proc = Bun.spawn([process.execPath, BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myName: string | null = null;
let mySummary = "";
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myTty: string | null = null;
/** True when Claude Code would drop anything we push (no channel listener). */
let pushDisabled = false;

async function register(): Promise<void> {
  // Recomputed here (not just at startup) so a re-register after a broker
  // restart still reports this session's true capability
  pushDisabled = !!process.ppid && (
    channelEnabled(process.ppid) === false ||
    // A scrubbed argv hides the channel flags, so it can't say whether push
    // is on -- but a scrubbed launch with no terminal is a harness driving
    // Claude Code with --print (OpenClaw does exactly this), and Claude Code
    // does not deliver channel pushes in non-interactive mode: its debug log
    // reads "pollChannel=false ... nonInteractive=true", and a pushed message
    // never reached the model in three controlled runs on 2.1.89 and
    // 2.1.282. Pushing there would take mail off the broker and drop it; left
    // queued, the session still gets it through check_messages.
    (argvScrubbed(process.ppid) && !getTty())
  );
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    claude_pid: process.ppid || null,
    claude_key: process.ppid ? claudeKey(process.ppid) : null,
    runtime: getRuntimeId(),
    host: machineName(),
    push_enabled: !pushDisabled,
    cwd: myCwd,
    git_root: myGitRoot,
    tty: myTty,
    summary: mySummary,
  });
  myId = reg.id;
  myName = reg.name;
  log(`Registered as peer ${myName} (${myId})`);
  await stepAsideForBridge();
}

/**
 * If an OpenClaw bridge (openclaw-bridge.ts) speaks for this workspace under
 * the name we hold, hand the name -- and its mailbox -- to the bridge. OpenClaw
 * keeps its Claude Code process alive between turns, so without this a turn
 * session that registered first keeps the name, and messages meant to wake
 * the agent sit in a mailbox nothing reads. Checked on every heartbeat too,
 * so a long-lived session yields when a bridge starts after it.
 */
async function stepAsideForBridge(): Promise<void> {
  if (!myId || !myName) return;
  const to = stepAsideName(readBridgeMarker(), { name: myName, cwd: myCwd, host: machineName() });
  if (!to) return;
  try {
    const res = await brokerFetch<{ ok: boolean; name?: string; error?: string }>("/set-name", { id: myId, name: to });
    if (res.ok) {
      log(`Stepped aside for the OpenClaw bridge: renamed ${myName} -> ${res.name ?? to}`);
      myName = res.name ?? to;
    }
  } catch {
    // Non-critical: retried at the next heartbeat
  }
}

/** The broker prunes peers it wrongly thinks are dead (e.g. after a laptop
 *  suspend starves container heartbeats) — a 404 means re-register. */
function isUnknownPeerError(e: unknown): boolean {
  return e instanceof Error && /404/.test(e.message) && /unknown peer/.test(e.message);
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

Every peer has a human-readable name (like "goofy-joe") and an 8-char ID — the two are interchangeable as addresses. You can also address a peer by its directory path (e.g. "~/archiver-tools"): the broker matches it against each peer's working directory and git repo. If a path matches several peers, the send fails and returns the candidates so you can pick one by name.

A session running subagents appears as a group: the top-level session keeps the base name (goofy-joe) and its agents are suffixed (goofy-joe-1, goofy-joe-2). Path addressing resolves to the top-level session; use a suffixed name to reach a specific agent.

Peers may live on different machines. list_peers reports each peer's Host, and a sender on another machine shows as name@host. Since the same directory can exist on several machines, qualify a path with the host when needed: "archiver:~/archiver-tools", or "archiver:" for that machine's session. A bare path that matches peers on multiple machines returns them as candidates.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_name, from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_name or from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by name, ID, or directory path
- whoami: Get your own name, ID, and context (use your name when referring to yourself)
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance. Address it by peer name (e.g. \"goofy-joe\"), peer ID, or directory path (e.g. \"~/archiver-tools\" — matches the peer's working directory or git repo). The message is pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string" as const,
          description:
            "Target peer: a name or ID from list_peers, or a directory path like ~/archiver-tools",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "whoami",
    description:
      "Get this instance's own identity on the peer network: name (e.g. \"goofy-joe\"), peer ID, working directory, git repo, and current summary. Use the name when introducing yourself to other peers or rendering status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `Name: ${p.name}`,
            `ID: ${p.id}`,
            `Host: ${p.host ?? machineName()}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to, to_id, message } = args as { to?: string; to_id?: string; message: string };
      const target = to ?? to_id;
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      if (!target) {
        return {
          content: [{ type: "text" as const, text: "Missing `to` (peer name, ID, or path)" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<SendMessageResponse>("/send-message", {
          from_id: myId,
          to: target,
          text: message,
        });
        if (!result.ok) {
          let text = `Failed to send: ${result.error}`;
          if (result.candidates && result.candidates.length > 0) {
            const lines = result.candidates.map(
              (p) => `- ${p.name} (${p.id}) in ${p.cwd}${p.summary ? ` — ${p.summary}` : ""}`
            );
            text += `\n${lines.join("\n")}`;
          }
          return {
            content: [{ type: "text" as const, text }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: result.queued_offline
                ? `No live session for "${target}" right now — message queued for ${result.to?.name}. ` +
                  `It is delivered when that session next starts (held for 7 days).`
                : result.recipient_no_push
                  ? `Queued for ${result.to?.name}, but that session did not load claude-peers as a ` +
                    `channel, so it will NOT see this until it runs check_messages. Do not expect a ` +
                    `reply; if it matters, tell the user to relaunch that session with ` +
                    `"--dangerously-load-development-channels server:claude-peers".`
                  : `Message sent to ${result.to ? `${result.to.name} (${result.to.id})` : target}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        mySummary = summary;
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "whoami": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      // Refresh from the broker: the name may have been assigned after a
      // raced registration, or changed via `cli.ts iam` / /set-name
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        myName = peers.find((p) => p.id === myId)?.name ?? myName;
      } catch {
        // Broker unreachable — report what we have
      }
      const parts = [
        `Name: ${myName ?? "(not assigned yet — broker unreachable)"}`,
        `ID: ${myId}`,
        `Host: ${machineName()}`,
        `CWD: ${myCwd}`,
      ];
      if (myGitRoot) parts.push(`Repo: ${myGitRoot}`);
      if (mySummary) parts.push(`Summary: ${mySummary}`);
      // Without the channel flag, Claude Code drops anything we push: this
      // session can send, but peers' replies will never arrive on their own.
      if (pushDisabled) {
        let pending = 0;
        try {
          pending = (await brokerFetch<{ count: number }>("/pending", { id: myId })).count;
        } catch {
          // Broker unreachable — report the condition without a count
        }
        parts.push(
          `Channel push: DISABLED — this session was not started with ` +
            `"--dangerously-load-development-channels server:claude-peers", so peer messages ` +
            `cannot arrive on their own. They are held for you: ${pending} waiting now — call ` +
            `check_messages to read them, and tell the user to relaunch with that flag for ` +
            `live delivery.`
        );
      }
      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  // If this session never loaded claude-peers as a channel, Claude Code
  // discards whatever we push. Polling would consume the messages on their
  // way into that void, so leave them queued instead: they stay visible in
  // `cli.ts log`, counted by /pending (statusline), and retrievable whenever
  // Claude calls check_messages.
  if (pushDisabled) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      // Look up the sender's info for context
      let fromName = "";
      let fromHost = "";
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromName = sender.name;
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
          // Qualify the name when the sender is on another machine, so the
          // preview line says where it came from
          if (sender.host && sender.host !== machineName()) {
            fromHost = sender.host;
          }
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification — this is what makes it immediate.
      // The sender name is prefixed into the content because the terminal's
      // one-line preview ("← claude-peers: ...") renders only the content —
      // meta attributes are invisible there.
      const baseLabel = fromName || msg.from_name || msg.from_id;
      const senderLabel = fromHost ? `${baseLabel}@${fromHost}` : baseLabel;
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `${senderLabel}: ${msg.text}`,
          meta: {
            from_id: msg.from_id,
            from_name: fromName,
            from_host: fromHost,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
          },
        },
      });

      log(`Pushed message from ${fromName || msg.from_id}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    if (isUnknownPeerError(e)) {
      log("Broker no longer knows us — re-registering");
      try {
        await register();
      } catch {
        // Broker still down, retry on next poll
      }
      return;
    }
    // Broker might be down temporarily, don't crash
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  writeMachineMarker();
  myTty = tty;
  mySummary = initialSummary;
  await register();

  if (pushDisabled) {
    log(
      `WARNING: session not started with --dangerously-load-development-channels ` +
        `server:claude-peers — inbound messages cannot be pushed, so they are left ` +
        `queued for check_messages instead of being consumed and lost`
    );
  }

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          mySummary = initialSummary;
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
        await stepAsideForBridge();
      } catch (e) {
        if (isUnknownPeerError(e)) {
          try {
            await register();
          } catch {
            // Broker down, retry on next beat
          }
        }
        // Otherwise non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  let orphanTimer: ReturnType<typeof setInterval> | undefined;
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearInterval(orphanTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Exit with our Claude session. Without this, a session that dies without
  // signaling us (killed terminal, crash) leaves this process orphaned —
  // running, heartbeating, and haunting everyone's peer list forever.
  // stdin EOF is the clean MCP disconnect...
  process.stdin.on("end", cleanup);
  process.stdin.on("close", cleanup);
  // ...and reparenting (belt and braces) means the parent died without
  // closing our pipe.
  const originalPpid = process.ppid;
  orphanTimer = setInterval(() => {
    const ppid = getParentPid(process.pid) ?? process.ppid;
    if (ppid !== originalPpid) {
      log("Parent Claude process exited — shutting down");
      cleanup();
    }
  }, 5000);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
