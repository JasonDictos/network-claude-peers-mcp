#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status              — Show broker status and all peers
 *   bun cli.ts peers               — List all peers
 *   bun cli.ts send <target> <msg> — Send a message (target: name, ID, or path)
 *   bun cli.ts broadcast <msg>     — Send a message to every peer (one per session)
 *   bun cli.ts whoami              — Show this session's peer name and ID
 *   bun cli.ts iam <name>          — Rename this session's peer
 *   bun cli.ts statusline          — Statusline command (reads Claude Code JSON on stdin)
 *   bun cli.ts log [-n N] [-f]     — Show message history (-f follows, tail-style)
 *   bun cli.ts kill <name>         — Remove a peer (stops its MCP server when local)
 *   bun cli.ts network-setup       — Configure cross-machine peering (--show/--client)
 *   bun cli.ts update              — Pull latest code, reinstall deps, restart the broker
 *   bun cli.ts kill-broker         — Stop the broker daemon
 */

import type { Peer, Message, SendMessageResponse } from "./shared/types.ts";
import { brokerFetch, BROKER_PORT, BROKER_URL, IS_REMOTE } from "./shared/client.ts";
import { claudeKey, getParentPid, getRuntimeId } from "./shared/runtime.ts";
import { sessionKey, resolveTarget } from "./shared/resolve.ts";
import { loadConfig, saveConfig, generateToken, CONFIG_PATH, machineName, accountEmail } from "./shared/config.ts";
import { hostMatches, resolveHost, localAddresses } from "./shared/hosts.ts";
import { hostname, networkInterfaces } from "node:os";

function listAllPeers(timeoutMs = 3000): Promise<Peer[]> {
  return brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null }, timeoutMs);
}

/** "goofy-joe" locally, "goofy-joe@archiver" for peers on another machine. */
function peerLabel(p: Peer): string {
  const host = p.host ?? machineName();
  return host === machineName() ? p.name : `${p.name}@${host}`;
}

function formatPeer(p: Peer): string {
  // Flag sessions that cannot be shown pushed messages, so the roster tells
  // you who will actually see what you send
  const flag = p.push_enabled === 0 ? "  [no-push]" : "";
  const parts = [`${peerLabel(p)}${flag}  ${p.id}  PID:${p.pid}  ${p.cwd}`];
  if (p.summary) parts.push(`  Summary: ${p.summary}`);
  return parts.join("\n");
}

/** PIDs of this process's ancestors (nearest first). */
function getAncestorPids(maxDepth = 10): number[] {
  const ancestors: number[] = [];
  let pid = process.pid;
  for (let i = 0; i < maxDepth; i++) {
    let ppid = getParentPid(pid);
    if (ppid == null) {
      // No /proc (macOS) — fall back to ps
      const proc = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
      ppid = parseInt(new TextDecoder().decode(proc.stdout).trim(), 10) || null;
    }
    if (!ppid || ppid <= 1) break;
    ancestors.push(ppid);
    pid = ppid;
  }
  return ancestors;
}

/**
 * Find the peer belonging to the Claude Code session this command runs inside.
 * Primary: a peer whose claude_key (or legacy claude_pid) matches one of our
 * ancestor processes — the key includes the process start time, so a
 * container pid can't collide with an identically-numbered host pid.
 * Fallback: a unique cwd match.
 */
function findSelf(peers: Peer[], cwd: string): Peer | null {
  // Only peers on this machine can be us: pid numbers repeat across hosts
  const here = machineName();
  peers = peers.filter((p) => (p.host ?? here) === here);
  const ancestors = getAncestorPids();
  for (const pid of ancestors) {
    const key = claudeKey(pid);
    const matches = peers.filter(
      (p) => p.claude_key === key || (p.claude_key == null && p.claude_pid === pid)
    );
    if (matches.length > 0) {
      // Several matches = session with subagent MCP connections; the
      // primary (top-level session) is the earliest registration
      return matches.reduce((a, b) => (a.registered_at <= b.registered_at ? a : b));
    }
  }
  const byCwd = peers.filter((p) => p.cwd === cwd);
  return byCwd.length === 1 ? byCwd[0]! : null;
}

/**
 * Message text for send/broadcast: from argv, or from stdin when the args
 * are empty or "-". Shells eat metachars (&&, |, ;) in unquoted arguments —
 * piping or heredoc'ing the message avoids the whole quoting problem:
 *   bun cli.ts send goofy-joe - <<'EOF'
 *   run make && make install; don't ask
 *   EOF
 */
async function messageFromArgsOrStdin(args: string[]): Promise<string> {
  const joined = args.join(" ").trim();
  if (joined && joined !== "-") return joined;
  const stdin = (await Bun.stdin.text()).trim();
  return stdin;
}

function getGitBranch(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, "symbolic-ref", "--short", "HEAD"], {
      stderr: "ignore",
    });
    const branch = new TextDecoder().decode(proc.stdout).trim();
    return proc.exitCode === 0 && branch ? branch : null;
  } catch {
    // git not installed/found in PATH (e.g. a minimal container) -- the
    // statusline must never crash over this, just omit the branch segment.
    return null;
  }
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await listAllPeers();
        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${peerLabel(p)}  ${p.id}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    // Optional host filter: `peers archiver` (short name, FQDN, or IP)
    const hostFilter = process.argv[3];
    try {
      let peers = await listAllPeers();
      if (hostFilter) {
        peers = peers.filter((p) => hostMatches(p.host ?? machineName(), hostFilter));
      }
      if (peers.length === 0) {
        console.log(hostFilter ? `No peers on ${hostFilter}.` : "No peers registered.");
      } else {
        for (const p of peers) {
          console.log(formatPeer(p));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const target = process.argv[3];
    const msg = target ? await messageFromArgsOrStdin(process.argv.slice(4)) : "";
    if (!target || !msg) {
      console.error("Usage: bun cli.ts send <name|id|path> <message>  (or pipe the message on stdin)");
      process.exit(1);
    }
    try {
      // Send as the Claude session this command runs inside, when there is
      // one (like broadcast). A bare "cli" sender is not a peer, so nothing
      // can answer it -- a reply from anyone, including an OpenClaw bridge
      // that auto-replies, fails with 'No peer matches "cli"'.
      const self = findSelf(await listAllPeers().catch(() => [] as Peer[]), process.cwd());
      const result = await brokerFetch<SendMessageResponse>("/send-message", {
        from_id: self?.id ?? "cli",
        to: target,
        text: msg,
      });
      if (result.ok) {
        console.log(
          result.queued_offline
            ? `No live session for "${target}" — queued for ${result.to?.name} (delivered when it returns)`
            : result.recipient_no_push
              ? `Queued for ${result.to?.name} — that session has no channel listener, so it only sees ` +
                `this via check_messages (relaunch it with --dangerously-load-development-channels ` +
                `server:claude-peers for live delivery)`
              : `Message sent to ${result.to ? `${result.to.name} (${result.to.id})` : target}`
        );
      } else {
        console.error(`Failed: ${result.error}`);
        if (result.candidates && result.candidates.length > 0) {
          for (const p of result.candidates) {
            console.error(`  ${peerLabel(p)}  ${p.id}  ${p.cwd}${p.summary ? ` — ${p.summary}` : ""}`);
          }
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "iam": {
    const newName = process.argv[3];
    if (!newName) {
      console.error("Usage: bun cli.ts iam <name>");
      process.exit(1);
    }
    try {
      const peers = await listAllPeers();
      const self = findSelf(peers, process.cwd());
      if (!self) {
        console.error("Not inside a registered Claude Code session — can't tell which peer is me.");
        process.exit(1);
      }
      const result = await brokerFetch<{ ok: boolean; error?: string; name?: string }>("/set-name", {
        id: self.id,
        name: newName,
      });
      if (result.ok) {
        console.log(`Renamed ${self.name} -> ${result.name} (${self.id})`);
      } else {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  case "broadcast": {
    const msg = await messageFromArgsOrStdin(process.argv.slice(3));
    if (!msg) {
      console.error("Usage: bun cli.ts broadcast <message>  (or pipe the message on stdin)");
      process.exit(1);
    }
    try {
      const peers = await listAllPeers();
      const self = findSelf(peers, process.cwd());
      const selfKey = self ? sessionKey(self) : null;

      // One message per session: collapse agent groups to their primary and
      // skip our own session
      const seen = new Set<string>();
      const targets = peers
        .sort((a, b) => a.registered_at.localeCompare(b.registered_at))
        .filter((p) => {
          if (self && (p.id === self.id || (selfKey && sessionKey(p) === selfKey))) return false;
          const key = sessionKey(p);
          if (key == null) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      if (targets.length === 0) {
        console.log("No other peers to broadcast to.");
        break;
      }
      for (const p of targets) {
        const result = await brokerFetch<SendMessageResponse>("/send-message", {
          from_id: self?.id ?? "cli",
          to: p.id,
          text: msg,
        });
        console.log(result.ok ? `-> ${peerLabel(p)} (${p.cwd})` : `!! ${peerLabel(p)}: ${result.error}`);
      }
      console.log(`Broadcast to ${targets.length} peer(s).`);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  case "whoami": {
    try {
      const peers = await listAllPeers();
      const self = findSelf(peers, process.cwd());
      if (self) {
        console.log(`${self.name} (${self.id})  ${self.host ?? machineName()}:${self.cwd}`);
        if (self.summary) console.log(self.summary);
        // Registered but not loaded as a channel = inbound messages are
        // silently dropped by Claude Code. Say so; it looks like a network
        // fault otherwise. Trust the flag the peer's own MCP server stored:
        // only that process knows how it was loaded (CLAUDE_PLUGIN_ROOT is in
        // its environment, not ours), so recomputing it here gets it wrong.
        if (self.push_enabled === 0) {
          let pending = 0;
          try {
            pending = (await brokerFetch<{ count: number }>("/pending", { id: self.id })).count;
          } catch {
            // Broker unreachable — still worth warning
          }
          console.log(
            `\nWARNING: this session did not load claude-peers as a channel, so peer messages\n` +
              `cannot arrive on their own${pending > 0 ? ` (${pending} waiting)` : ""}. ` +
              `They are held, not lost: ask this session to\n` +
              `run check_messages, or see them all with "cli.ts log". For live delivery, relaunch:\n` +
              `  claude --dangerously-load-development-channels server:claude-peers`
          );
        }
      } else {
        console.log("Not inside a registered Claude Code session.");
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "statusline": {
    // Reads Claude Code's statusline JSON on stdin. Must be fast and must
    // never fail — degrade to cwd (+ branch) if the broker is unreachable.
    let cwd = process.cwd();
    let model: string | null = null;
    try {
      const input = JSON.parse(await Bun.stdin.text());
      cwd = input.cwd ?? input.workspace?.current_dir ?? cwd;
      model = input.model?.display_name ?? null;
    } catch {
      // No/bad stdin — fall back to process cwd
    }

    const home = process.env.HOME ?? "";
    const short = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
    const branch = getGitBranch(cwd);

    let name: string | null = null;
    let pushOff = false;
    let pending = 0;
    try {
      const peers = await listAllPeers(300);
      const self = findSelf(peers, cwd);
      name = self?.name ?? null;
      // Registered, but the session never loaded claude-peers as a channel:
      // inbound messages are dropped silently, so flag it in the status bar
      pushOff = self?.push_enabled === 0;
      // Push is off, so messages sit queued rather than arriving — show how
      // many are waiting. Only in this case: with push on the queue is
      // drained within a second, so it would always read zero.
      if (pushOff && self) {
        pending = (await brokerFetch<{ count: number }>("/pending", { id: self.id }, 250)).count;
      }
    } catch {
      // Broker down — no name
    }

    // Docker detection: /.dockerenv is the compose/docker marker; cgroup
    // scan covers other container runtimes. Cheap sync checks, never throw.
    let inDocker = false;
    try {
      const { existsSync, readFileSync } = await import("node:fs");
      inDocker =
        existsSync("/.dockerenv") ||
        (existsSync("/proc/1/cgroup") &&
          /docker|containerd|kubepods/.test(readFileSync("/proc/1/cgroup", "utf8")));
    } catch {
      // Unreadable proc — assume host
    }

    let line = `\x1b[36m${short}\x1b[0m`;
    const email = accountEmail();
    if (email) line += ` \x1b[90m${email}\x1b[0m`;
    if (branch) line += ` \x1b[93m${branch}\x1b[0m`;
    if (name) line += ` \x1b[95m· ${name}\x1b[0m`;
    if (pushOff) {
      line += pending > 0
        ? ` \x1b[91m[${pending} queued, no-push]\x1b[0m`
        : ` \x1b[91m[no-push]\x1b[0m`;
    }
    if (model) line += ` \x1b[92m· ${model}\x1b[0m`;
    line += inDocker ? ` \x1b[94m[docker]\x1b[0m` : ` \x1b[38;5;208m[host]\x1b[0m`;
    process.stdout.write(line);
    break;
  }

  case "log": {
    // Full message history, names and text untruncated. -f follows (tail
    // style): run it as a background task and Claude Code's ctrl-b viewer
    // shows the live feed; works the same in a tmux window.
    const follow = process.argv.includes("-f");
    const nIdx = process.argv.indexOf("-n");
    const limit = nIdx > -1 ? parseInt(process.argv[nIdx + 1] ?? "50", 10) || 50 : 50;
    const fmt = (m: Message) =>
      `${m.sent_at.slice(0, 19).replace("T", " ")}  ${m.from_name || m.from_id} -> ${m.to_name || m.to_id}: ${m.text}`;
    let lastId = 0;
    try {
      const initial = await brokerFetch<{ messages: Message[] }>("/log", { limit });
      if (initial.messages.length === 0 && !follow) {
        console.log("No messages logged yet.");
        break;
      }
      for (const m of initial.messages) {
        console.log(fmt(m));
        lastId = m.id;
      }
    } catch {
      console.log("Broker is not running.");
      break;
    }
    while (follow) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await brokerFetch<{ messages: Message[] }>("/log", {
          after_id: lastId,
          limit: 500,
        });
        for (const m of res.messages) {
          console.log(fmt(m));
          lastId = m.id;
        }
      } catch {
        // Broker briefly down — keep following
      }
    }
    break;
  }

  case "kill": {
    // Remove a peer — normally a stale registration whose session is gone but
    // whose MCP server is still heartbeating, which holds that directory's
    // sticky name hostage.
    const target = process.argv[3];
    if (!target) {
      console.error("Usage: bun cli.ts kill <name|id|path>");
      process.exit(1);
    }
    try {
      const peers = await listAllPeers();
      const r = resolveTarget(peers, target, process.env.HOME ?? "/");
      if (r.kind === "none") {
        console.error(`No peer matches "${target}".`);
        process.exit(1);
      }
      if (r.kind === "ambiguous") {
        console.error(`"${target}" matches several peers — name one:`);
        for (const p of r.candidates) console.error(`  ${peerLabel(p)}  ${p.id}  ${p.cwd}`);
        process.exit(1);
      }
      const peer = r.peer;
      const self = findSelf(peers, process.cwd());
      if (self && self.id === peer.id) {
        console.error(`That's this session (${peer.name}) — refusing to disconnect yourself.`);
        process.exit(1);
      }

      // Its pid is only meaningful in its own PID namespace: a container pid
      // or another machine's pid would be someone else's process here.
      const local = peer.runtime === getRuntimeId();
      let killed = false;
      if (local) {
        try {
          process.kill(peer.pid, "SIGTERM");
          for (let i = 0; i < 20 && !killed; i++) {
            await new Promise((r) => setTimeout(r, 100));
            try {
              process.kill(peer.pid, 0);
            } catch {
              killed = true;
            }
          }
          if (!killed) {
            process.kill(peer.pid, "SIGKILL");
            killed = true;
          }
        } catch {
          killed = true; // already gone
        }
      }

      await brokerFetch("/unregister", { id: peer.id });
      console.log(`Removed ${peerLabel(peer)} (${peer.id}) from the peer list.`);
      if (killed) {
        console.log(`Its MCP server (pid ${peer.pid}) was stopped.`);
      } else {
        const where = (peer.runtime ?? "").split(":")[0] || peer.host || "elsewhere";
        console.log(
          `Its MCP server runs in another runtime (${where}, pid ${peer.pid}), so it could not be ` +
            `signalled from here. If that process is still alive it will re-register shortly — stop ` +
            `it there, e.g. docker exec <container> kill ${peer.pid}`
        );
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  case "network-setup": {
    const args = process.argv.slice(3);
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i > -1 ? args[i + 1] : undefined;
    };
    const config = loadConfig();

    if (args.includes("--show")) {
      console.log(`Config file: ${CONFIG_PATH}`);
      console.log(`Role:        ${config.broker ? `client of ${config.broker}` : "broker host"}`);
      console.log(`Bind:        ${config.bind}`);
      console.log(`Token:       ${config.token ? `set (${config.token.slice(0, 8)}…)` : "none"}`);
      break;
    }

    const clientArg = flag("--client");
    if (clientArg) {
      // This machine joins a broker hosted elsewhere. Accept a bare hostname
      // ("jason-desktop"), host:port, or a full URL.
      const token = flag("--token") ?? config.token;
      if (!token) {
        console.error("Need --token <token> (get it from the broker host: cli.ts network-setup --show)");
        process.exit(1);
      }
      let url = clientArg;
      if (!/^https?:\/\//.test(url)) url = `http://${url}`;
      if (!/:\d+$/.test(new URL(url).host)) url = `http://${new URL(url).hostname}:${BROKER_PORT}`;

      // Verify the name resolves here — a broker URL naming a host this
      // machine can't look up fails every poll with an opaque DNS error
      const target = new URL(url).hostname;
      const addr = await resolveHost(target);
      if (!addr) {
        console.error(`Cannot resolve "${target}" from this machine.`);
        console.error(`  Use the broker's IP instead: --client http://<ip>:${BROKER_PORT}`);
        console.error(`  or add it to /etc/hosts:      <ip>  ${target}`);
        process.exit(1);
      }
      let reachable = false;
      try {
        const res = await fetch(`${url}/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        reachable = res.ok;
      } catch {
        reachable = false;
      }
      saveConfig({ broker: url, token });
      console.log(`Joined ${url} (${target} -> ${addr}) as a client. Config: ${CONFIG_PATH}`);
      console.log(
        reachable
          ? "Broker answered — restart Claude Code sessions here to register on the network."
          : `WARNING: no answer from ${url} yet. Check the broker is running with a network bind, ` +
              `the token matches, and the port is open.`
      );
      break;
    }

    // Make this machine the broker host
    const token = config.token ?? generateToken();
    const bind = flag("--bind") ?? (config.bind === "127.0.0.1" ? "0.0.0.0" : config.bind);
    saveConfig({ token, bind, broker: null });

    // Offer every name/address a remote peer could actually use: the hostname
    // if it resolves from elsewhere, plus routable IPs as the fallback
    const me = hostname();
    const resolved = await resolveHost(me);
    const addrs = localAddresses(networkInterfaces());
    console.log(`This machine is now the broker host (config: ${CONFIG_PATH}).`);
    console.log(`  bind:  ${bind}:${BROKER_PORT}`);
    console.log(`  token: ${token}`);
    console.log(`\nRestart the broker to pick up the new bind:`);
    console.log(`  bun cli.ts kill-broker && bun broker.ts &`);
    console.log(`\nOn each remote machine, run whichever address it can reach:`);
    if (resolved) console.log(`  bun cli.ts network-setup --client ${me} --token ${token}`);
    for (const a of addrs) {
      console.log(`  bun cli.ts network-setup --client ${a} --token ${token}`);
    }
    if (!resolved) {
      console.log(`\nNote: "${me}" does not resolve even locally — remote machines will need an IP`);
      console.log(`or an /etc/hosts entry pointing "${me}" at one of the addresses above.`);
    }
    break;
  }

  case "update": {
    // One command per machine: pull, install if deps moved, restart the
    // broker this machine hosts. Sessions pick up new code when their MCP
    // server next starts (a /mcp reconnect is enough).
    const repoDir = new URL("./", import.meta.url).pathname;
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-C", repoDir, ...args], { stderr: "pipe" });
    const out = (r: ReturnType<typeof Bun.spawnSync>) =>
      new TextDecoder().decode(r.stdout).trim();

    const before = out(git("rev-parse", "--short", "HEAD"));
    const branch = out(git("rev-parse", "--abbrev-ref", "HEAD"));
    // Pull the current branch from origin explicitly: a checkout without
    // upstream tracking (a fresh clone of a branch, a detached deploy) should
    // still update rather than fail on "no tracking information".
    const pull = git("pull", "--ff-only", "--quiet", "origin", branch);
    if (pull.exitCode !== 0) {
      console.error(`git pull failed on ${branch}: ${new TextDecoder().decode(pull.stderr).trim()}`);
      console.error("(local changes, or the branch has diverged — resolve, then rerun)");
      process.exit(1);
    }
    const after = out(git("rev-parse", "--short", "HEAD"));

    if (before === after) {
      console.log(`Already up to date (${after}).`);
    } else {
      console.log(`Updated ${before} -> ${after}:`);
      console.log(out(git("log", "--oneline", `${before}..${after}`)));
      // Dependencies may have moved with the code
      const deps = out(git("diff", "--name-only", `${before}..${after}`, "--", "package.json", "bun.lock"));
      if (deps) {
        console.log("Dependencies changed — running bun install");
        Bun.spawnSync([process.execPath, "install"], { cwd: repoDir, stdout: "inherit", stderr: "inherit" });
      }
    }

    // The broker is long-lived, so it keeps running old code until restarted.
    // Only restart the one this machine hosts.
    if (IS_REMOTE) {
      console.log(`Broker runs on ${BROKER_URL} — update and restart it there too.`);
    } else if (before !== after) {
      const lsof = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`, "-sTCP:LISTEN"]);
      const pids = new TextDecoder().decode(lsof.stdout).trim().split("\n").filter(Boolean);
      for (const pid of pids) process.kill(parseInt(pid), "SIGTERM");
      Bun.spawn(["setsid", process.execPath, `${repoDir}broker.ts`], {
        stdio: ["ignore", "ignore", "ignore"],
      }).unref();
      console.log("Broker restarted on the new code.");
    }

    if (before !== after) {
      console.log("Sessions keep running the old code until their MCP server restarts — /mcp reconnect, or start a new session.");
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Kill only the process LISTENING on the port — a bare `lsof -ti :port`
      // also lists every client with a connection to it (MCP servers, us)
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`, "-sTCP:LISTEN"]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status              Show broker status and all peers
  bun cli.ts peers               List all peers
  bun cli.ts send <target> <msg> Send a message (target: name, ID, or ~/path)
  bun cli.ts broadcast <msg>     Send a message to every peer (one per session)
  bun cli.ts whoami              Show this session's peer name and ID
  bun cli.ts iam <name>          Rename this session's peer
  bun cli.ts statusline          Statusline command (Claude Code JSON on stdin)
  bun cli.ts log [-n N] [-f]     Show message history (-f follows, tail-style)
  bun cli.ts kill <name|id|path> Remove a peer (stops its MCP server when local)
  bun cli.ts network-setup       Cross-machine peering (--show, --client <url> --token <t>)
  bun cli.ts update              Pull latest code, reinstall deps, restart the broker
  bun cli.ts kill-broker         Stop the broker daemon`);
}
