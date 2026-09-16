import { test, expect, describe } from "bun:test";
import { channelEnabled, readCmdline } from "./runtime.ts";

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
});
