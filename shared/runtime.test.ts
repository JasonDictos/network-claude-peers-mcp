import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argvScrubbed, channelEnabled, readCmdline } from "./runtime.ts";

describe("readCmdline", () => {
  test("reads this process's own argv", () => {
    const argv = readCmdline(process.pid);
    expect(argv).not.toBeNull();
    expect(argv!.join(" ")).toContain("bun");
  });

  test("null for a pid that cannot exist", () => {
    expect(readCmdline(2 ** 30)).toBeNull();
  });
});

describe("channelEnabled", () => {
  // Spawn a real process carrying representative Claude argv, so the check
  // reads an actual /proc/<pid>/cmdline rather than a stub
  // bash -c takes trailing words as positional params, so it carries any
  // argv we like (unlike `sleep`, which exits on unknown flags — a dead
  // process reads as null and would fake a pass)
  function withArgv<T>(args: string[], fn: (pid: number) => T): T {
    const proc = Bun.spawn(["bash", "-c", "sleep 5; :", "claude", ...args]);
    try {
      // /proc/<pid>/cmdline is empty until the child has exec'd
      let argv: string[] | null = null;
      for (let i = 0; i < 100 && !argv?.length; i++) {
        argv = readCmdline(proc.pid);
        if (!argv?.length) Bun.sleepSync(10);
      }
      expect(argv?.join(" ")).toContain(args[args.length - 1]!);
      return fn(proc.pid);
    } finally {
      proc.kill();
    }
  }

  test("true when loaded as a development channel", () => {
    withArgv(["--dangerously-load-development-channels", "server:claude-peers"], (pid) => {
      expect(channelEnabled(pid, "claude-peers", undefined)).toBe(true);
    });
  });

  test("true for a plugin channel entry, when we ARE the plugin's server", () => {
    withArgv(["--channels", "plugin:claude-peers@my-marketplace"], (pid) => {
      expect(channelEnabled(pid, "claude-peers", "/mkt/claude-peers")).toBe(true);
    });
  });

  // The silent-loss bug: the same server name registered BOTH in a plugin and
  // in .claude.json. The config copy wins the connection but is authorized by
  // `server:`, not the plugin entry — Claude Code logs "server claude-peers
  // not in --channels list" and discards every push. Reporting push as working
  // here makes the server drain the broker into a void.
  test("false when a config-scope server sees only the plugin's entry", () => {
    withArgv(["--channels", "plugin:claude-peers@my-marketplace"], (pid) => {
      expect(channelEnabled(pid, "claude-peers", undefined)).toBe(false);
    });
  });

  // `server:` entries are development-only: plain --channels refuses them
  // ("not on the approved channels allowlist (use
  // --dangerously-load-development-channels for local dev)") and drops every
  // push. Matching the bare token anywhere in argv reads that launch as
  // working and drains the broker into a void.
  test("false for a server: entry under plain --channels", () => {
    withArgv(["--channels", "server:claude-peers"], (pid) => {
      expect(channelEnabled(pid, "claude-peers", undefined)).toBe(false);
    });
  });

  test("false when the plugin's server sees only a server: entry", () => {
    withArgv(["--dangerously-load-development-channels", "server:claude-peers"], (pid) => {
      expect(channelEnabled(pid, "claude-peers", "/mkt/claude-peers")).toBe(false);
    });
  });

  test("a plugin entry for a DIFFERENT plugin does not enable us", () => {
    withArgv(["--channels", "plugin:something-else@my-marketplace"], (pid) => {
      expect(channelEnabled(pid, "claude-peers", "/mkt/claude-peers")).toBe(false);
    });
  });

  test("false when only another channel is loaded (the silent-drop case)", () => {
    withArgv(["--channels", "plugin:telegram@claude-plugins-official"], (pid) => {
      expect(channelEnabled(pid)).toBe(false);
    });
  });

  test("false when the name only appears as an MCP path, not a channel entry", () => {
    withArgv(["--mcp-config", "/home/jason/claude-peers-mcp/server.ts"], (pid) => {
      expect(channelEnabled(pid)).toBe(false);
    });
  });

  test("null when the process is gone", () => {
    expect(channelEnabled(2 ** 30)).toBeNull();
  });

  // A genuinely bare launch must still read as "no channel" -- the scrub check
  // below must not swallow it.
  test("false for a bare launch with no arguments", () => {
    const proc = Bun.spawn(["bash", "-c", "exec -a claude sleep 5"]);
    try {
      let argv: string[] | null = null;
      for (let i = 0; i < 100 && argv?.[0] !== "claude"; i++) {
        argv = readCmdline(proc.pid);
        if (argv?.[0] !== "claude") Bun.sleepSync(10);
      }
      expect(argv).toEqual(["claude", "5"]);
    } finally {
      proc.kill();
    }
  });
});

// OpenClaw (via Node's process.title) overwrites Claude Code's argv in place:
// the title, then NUL padding over where the real flags were. Reading that as
// "no channel entry" switched push off for a session launched WITH the flags,
// and the broker then held every message for polling (claudebot@home).
describe("scrubbed argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrub-"));
  const bin = join(dir, "scrub");
  const src = join(dir, "scrub.c");
  writeFileSync(src, `
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char *end = argv[argc - 1] + strlen(argv[argc - 1]);
  memset(argv[0], 0, end - argv[0]);
  strcpy(argv[0], "claude");
  sleep(5);
  return 0;
}`);
  const built = Bun.spawnSync(["cc", "-o", bin, src]).exitCode === 0;

  test.skipIf(!built)("reads as can't-tell (null), not as no-push", () => {
    const proc = Bun.spawn([bin, "--dangerously-load-development-channels", "server:claude-peers"]);
    try {
      for (let i = 0; i < 100 && !argvScrubbed(proc.pid); i++) Bun.sleepSync(10);
      expect(argvScrubbed(proc.pid)).toBe(true);
      expect(readCmdline(proc.pid)).toEqual(["claude"]);
      expect(channelEnabled(proc.pid)).toBeNull();
    } finally {
      proc.kill();
    }
  });

  test("a normal argv is not reported as scrubbed", () => {
    expect(argvScrubbed(process.pid)).toBe(false);
  });
});
