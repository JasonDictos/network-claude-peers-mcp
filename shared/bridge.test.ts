import { test, expect, describe } from "bun:test";
import { buildPrompt, extractReply, isLoopback, readBridgeMarker, senderLabel, stepAsideName } from "./bridge.ts";

const self = { id: "bridge01", host: "home", cwd: "/home/claude-bot/.openclaw/workspace" };

describe("isLoopback", () => {
  test("the bridge's own id", () => {
    expect(isLoopback(null, "bridge01", self)).toBe(true);
  });

  // The agent's per-turn Claude Code sessions run in the same workspace on
  // the same host. Bridging their messages would let a turn wake itself.
  test("a session in the agent's own workspace on the same host", () => {
    expect(isLoopback({ id: "t1", name: "workspace", host: "home", cwd: self.cwd }, "t1", self)).toBe(true);
  });

  test("same workspace path on a different host is someone else", () => {
    expect(isLoopback({ id: "t2", name: "x", host: "jason-desktop", cwd: self.cwd }, "t2", self)).toBe(false);
  });

  test("an ordinary peer", () => {
    expect(isLoopback({ id: "p1", name: "spiffy-gus", host: "jason-desktop", cwd: "/home/jason" }, "p1", self)).toBe(false);
  });

  test("an unknown (departed) sender is not treated as loopback", () => {
    expect(isLoopback(null, "gone1", self)).toBe(false);
  });
});

describe("senderLabel", () => {
  test("qualifies off-machine senders", () => {
    expect(senderLabel("spiffy-gus", "jason-desktop", "home")).toBe("spiffy-gus@jason-desktop");
  });
  test("leaves local senders bare", () => {
    expect(senderLabel("x", "home", "home")).toBe("x");
    expect(senderLabel("x", null, "home")).toBe("x");
  });
});

describe("buildPrompt", () => {
  test("one message: sender, text, and the reply contract", () => {
    const p = buildPrompt([{ label: "spiffy-gus@jason-desktop", text: "ping", sent_at: "t" }], "claudebot");
    expect(p).toContain("Peer message from spiffy-gus@jason-desktop:");
    expect(p).toContain("ping");
    expect(p).toContain('sent back automatically to spiffy-gus@jason-desktop as "claudebot"');
    expect(p).toContain("do not also call send_message");
  });

  test("a batch labels each message", () => {
    const p = buildPrompt(
      [
        { label: "a", text: "one", sent_at: "t1" },
        { label: "b", text: "two", sent_at: "t2" },
      ],
      "claudebot"
    );
    expect(p).toContain("2 peer messages from a, b:");
    expect(p).toContain("--- a (t1) ---");
    expect(p).toContain("--- b (t2) ---");
    expect(p).toContain("each sender above");
  });
});

describe("extractReply", () => {
  // Trimmed from a real `openclaw agent --json` run (OpenClaw 2026.9.6)
  const real = JSON.stringify({
    runId: "c60cbedb",
    status: "ok",
    summary: "completed",
    result: {
      payloads: [{ text: "probe-ok", mediaUrl: null }],
      meta: { finalAssistantVisibleText: "probe-ok" },
    },
  });

  test("reads the payload text of a real run", () => {
    expect(extractReply(real)).toEqual({ ok: true, text: "probe-ok" });
  });

  test("joins multiple payloads", () => {
    const doc = JSON.stringify({ status: "ok", result: { payloads: [{ text: "a" }, { text: "b" }] } });
    expect(extractReply(doc).text).toBe("a\n\nb");
  });

  test("falls back to finalAssistantVisibleText", () => {
    const doc = JSON.stringify({ status: "ok", result: { payloads: [], meta: { finalAssistantVisibleText: "x" } } });
    expect(extractReply(doc).text).toBe("x");
  });

  test("ok with no reply text", () => {
    expect(extractReply(JSON.stringify({ status: "ok", result: { payloads: [] } }))).toEqual({ ok: true, text: null });
  });

  test("a failed run", () => {
    const r = extractReply(JSON.stringify({ status: "error", summary: "model overloaded" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("model overloaded");
  });

  test("non-JSON output", () => {
    expect(extractReply("Error: gateway not running").ok).toBe(false);
  });
});

describe("stepAsideName", () => {
  const marker = { name: "claudebot", cwd: "/w", host: "home", pid: 1 };
  test("a turn session holding the bridged name steps aside", () => {
    expect(stepAsideName(marker, { name: "claudebot", cwd: "/w", host: "home" })).toBe("claudebot-turn");
  });
  test("no marker, other name, other workspace or host: keep the name", () => {
    expect(stepAsideName(null, { name: "claudebot", cwd: "/w", host: "home" })).toBeNull();
    expect(stepAsideName(marker, { name: "workspace", cwd: "/w", host: "home" })).toBeNull();
    expect(stepAsideName(marker, { name: "claudebot", cwd: "/x", host: "home" })).toBeNull();
    expect(stepAsideName(marker, { name: "claudebot", cwd: "/w", host: "desk" })).toBeNull();
  });
});

describe("readBridgeMarker", () => {
  test("null for a marker whose pid is dead", () => {
    const { mkdtempSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const p = join(mkdtempSync(join(tmpdir(), "bm-")), "m.json");
    writeFileSync(p, JSON.stringify({ name: "claudebot", cwd: "/w", host: "home", pid: 2 ** 30 }));
    expect(readBridgeMarker(p)).toBeNull();
  });
  test("reads a live marker", () => {
    const { mkdtempSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const p = join(mkdtempSync(join(tmpdir(), "bm-")), "m.json");
    writeFileSync(p, JSON.stringify({ name: "claudebot", cwd: "/w", host: "home", pid: process.pid }));
    expect(readBridgeMarker(p)?.name).toBe("claudebot");
  });
});
