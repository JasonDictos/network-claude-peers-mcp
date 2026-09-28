#!/usr/bin/env bun
/**
 * claude-peers <-> OpenClaw bridge.
 *
 * Gives an OpenClaw agent a live identity on the claude-peers network. OpenClaw
 * runs Claude Code per turn, non-interactively, so the agent can neither hold
 * a peer registration between turns nor receive channel pushes during one
 * (see shared/bridge.ts). This daemon stands in for it:
 *
 *   1. Registers as a peer from the agent's workspace and claims its name
 *      (e.g. "claudebot"), which also hands it that name's mailbox -- mail
 *      queued while no session was live comes through too.
 *   2. Polls for messages. Each batch starts one OpenClaw turn:
 *        openclaw agent --agent <id> --json --message-file <prompt>
 *      Turns never overlap; messages arriving mid-turn go in the next batch.
 *   3. Sends the agent's final reply back to each sender, as <name>.
 *
 * Usage (run as the OpenClaw user, next to the gateway):
 *   bun openclaw-bridge.ts --name claudebot \
 *     --cwd ~/.openclaw/workspace --agent main [--openclaw <bin>] [--timeout 900]
 *
 * Environment equivalents: OPENCLAW_BRIDGE_NAME, OPENCLAW_BRIDGE_CWD,
 * OPENCLAW_BRIDGE_AGENT, OPENCLAW_BIN, OPENCLAW_BRIDGE_TIMEOUT.
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brokerFetch } from "./shared/client.ts";
import { getRuntimeId } from "./shared/runtime.ts";
import { machineName } from "./shared/config.ts";
import {
  bridgeMarkerPath,
  buildPrompt,
  extractReply,
  isLoopback,
  senderLabel,
  type InboundMessage,
  type SenderInfo,
} from "./shared/bridge.ts";
import type { Peer, PollMessagesResponse, RegisterResponse, SendMessageResponse } from "./shared/types.ts";

// --- config ---

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

const NAME = (arg("--name") ?? process.env.OPENCLAW_BRIDGE_NAME ?? "").trim();
const CWD = expand(arg("--cwd") ?? process.env.OPENCLAW_BRIDGE_CWD ?? "~/.openclaw/workspace");
const AGENT = arg("--agent") ?? process.env.OPENCLAW_BRIDGE_AGENT ?? "main";
const OPENCLAW = arg("--openclaw") ?? process.env.OPENCLAW_BIN ?? "openclaw";
const TURN_TIMEOUT_MS = parseInt(arg("--timeout") ?? process.env.OPENCLAW_BRIDGE_TIMEOUT ?? "900", 10) * 1000;
const POLL_MS = 1000;
const HEARTBEAT_MS = 15_000;
const TURN_ATTEMPTS = 3;
const RETRY_MS = 15_000;

if (!NAME) {
  console.error("usage: openclaw-bridge.ts --name <peer-name> [--cwd <workspace>] [--agent <id>] [--openclaw <bin>]");
  process.exit(2);
}

const HOST = machineName();
const log = (msg: string) => console.error(`[openclaw-bridge] ${msg}`);

// --- registration ---

let myId: string | null = null;
/** Whether we hold NAME -- and with it, NAME's mailbox. */
let nameHeld = false;

async function register(): Promise<void> {
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    claude_pid: null,
    claude_key: null,
    runtime: getRuntimeId(),
    host: HOST,
    // The bridge consumes its own mail and acts on it, so senders should see
    // it as reachable, not as a session that only reads on check_messages.
    push_enabled: true,
    cwd: CWD,
    git_root: null,
    tty: null,
    summary: `OpenClaw agent "${AGENT}" via claude-peers bridge — messages start a turn`,
  });
  myId = reg.id;
  nameHeld = reg.name === NAME;
  if (!nameHeld) {
    const res = await brokerFetch<{ ok: boolean; error?: string }>("/set-name", { id: myId, name: NAME });
    if (!res.ok) {
      // Most likely one of the agent's own turn sessions holds the name right
      // now. Keep running under the drawn name and retry at each heartbeat.
      log(`could not claim "${NAME}" yet (${res.error}); registered as ${reg.name}`);
      return;
    }
    nameHeld = true;
  }
  log(`registered as ${NAME} (${myId}) in ${HOST}:${CWD}`);
}

async function ensureName(): Promise<void> {
  if (!myId || nameHeld) return;
  const res = await brokerFetch<{ ok: boolean; error?: string }>("/set-name", { id: myId, name: NAME }).catch(
    (e) => ({ ok: false, error: String(e) })
  );
  if (res.ok) {
    nameHeld = true;
    log(`now holding name ${NAME}`);
  }
}

const isUnknownPeer = (e: unknown) => e instanceof Error && /404/.test(e.message) && /unknown peer/.test(e.message);

// --- turns ---

const pending: InboundMessage[] = [];
let busy = false;

async function lookupSender(fromId: string): Promise<SenderInfo | null> {
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: CWD, git_root: null });
    const p = peers.find((x) => x.id === fromId);
    return p ? { id: p.id, name: p.name, host: p.host, cwd: p.cwd } : null;
  } catch {
    return null;
  }
}

async function send(to: string, text: string): Promise<void> {
  if (!myId) return;
  try {
    const res = await brokerFetch<SendMessageResponse>("/send-message", { from_id: myId, to, text });
    if (!res.ok) log(`reply to ${to} failed: ${res.error}`);
  } catch (e) {
    log(`reply to ${to} failed: ${e}`);
  }
}

async function runTurn(prompt: string): Promise<{ ok: boolean; text: string | null; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-bridge-"));
  const file = join(dir, "prompt.txt");
  writeFileSync(file, prompt);
  try {
    const proc = Bun.spawn([OPENCLAW, "agent", "--agent", AGENT, "--json", "--message-file", file], {
      cwd: CWD,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), TURN_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) {
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      return { ok: false, text: null, error: `openclaw exited ${code}${tail ? `: ${tail}` : ""}` };
    }
    return extractReply(stdout);
  } catch (e) {
    return { ok: false, text: null, error: `could not run ${OPENCLAW}: ${e}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function drain(): Promise<void> {
  if (busy || pending.length === 0 || !myId) return;
  busy = true;
  const batch = pending.splice(0, pending.length);
  try {
    // Resolve senders once: loop guard, labels, and where replies go
    const self = { id: myId, host: HOST, cwd: CWD };
    const items: { msg: InboundMessage; sender: SenderInfo | null; label: string; replyTo: string }[] = [];
    for (const msg of batch) {
      const sender = await lookupSender(msg.from_id);
      if (isLoopback(sender, msg.from_id, self)) {
        log(`ignoring message from own workspace session ${sender?.name ?? msg.from_id}`);
        continue;
      }
      const name = sender?.name ?? msg.from_name ?? msg.from_id;
      items.push({
        msg,
        sender,
        label: senderLabel(name, sender?.host ?? null, HOST),
        // A live sender by id; a departed one by name, which the broker holds
        // in that name's mailbox until the session returns
        replyTo: sender ? sender.id : name,
      });
    }
    if (items.length === 0) return;

    const prompt = buildPrompt(
      items.map((i) => ({ label: i.label, text: i.msg.text, sent_at: i.msg.sent_at })),
      NAME
    );
    log(`turn for ${items.length} message(s) from ${[...new Set(items.map((i) => i.label))].join(", ")}`);
    // The gateway can be briefly unreachable (a restart, a slow boot);
    // `openclaw agent` then fails fast. Retry before telling the sender.
    let result = await runTurn(prompt);
    for (let attempt = 2; !result.ok && attempt <= TURN_ATTEMPTS; attempt++) {
      log(`turn failed (${result.error}); retry ${attempt}/${TURN_ATTEMPTS} in ${RETRY_MS / 1000}s`);
      await Bun.sleep(RETRY_MS);
      result = await runTurn(prompt);
    }
    const reply = result.ok
      ? result.text ?? "(the agent finished the turn without a reply)"
      : `[${NAME} bridge] couldn't run the agent turn: ${result.error}`;
    for (const to of new Set(items.map((i) => i.replyTo))) await send(to, reply);
    log(result.ok ? "turn done, reply sent" : `turn failed: ${result.error}`);
  } finally {
    busy = false;
    // Anything that arrived during the turn
    if (pending.length) void drain();
  }
}

async function poll(): Promise<void> {
  if (!myId) return;
  try {
    const res = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    if (res.messages.length) {
      pending.push(...(res.messages as unknown as InboundMessage[]));
      void drain();
    }
  } catch (e) {
    if (isUnknownPeer(e)) {
      log("broker no longer knows us — re-registering");
      nameHeld = false;
      await register().catch(() => {});
    }
  }
}

// --- main ---

async function main() {
  // Advertise before registering, so a turn session that races us sees it
  const marker = bridgeMarkerPath();
  writeFileSync(marker, JSON.stringify({ name: NAME, cwd: CWD, host: HOST, pid: process.pid }));
  // The broker can be down at boot; keep trying rather than exiting, so a
  // systemd restart loop isn't the retry mechanism
  for (;;) {
    try {
      await register();
      break;
    } catch (e) {
      log(`broker unreachable (${e}); retrying in 5s`);
      await Bun.sleep(5000);
    }
  }
  await ensureName();

  const pollTimer = setInterval(poll, POLL_MS);
  const beatTimer = setInterval(async () => {
    if (!myId) return;
    try {
      await brokerFetch("/heartbeat", { id: myId });
      await ensureName();
    } catch (e) {
      if (isUnknownPeer(e)) {
        nameHeld = false;
        await register().catch(() => {});
      }
    }
  }, HEARTBEAT_MS);

  const stop = async () => {
    clearInterval(pollTimer);
    clearInterval(beatTimer);
    if (myId) await brokerFetch("/unregister", { id: myId }).catch(() => {});
    try {
      unlinkSync(marker);
    } catch {}
    log("stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
