import { test, expect, describe } from "bun:test";
import { renderCommand, commandAction, summarizeInstall } from "./commands.ts";

const TPL = `---
description: Send a message
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

!\`@@BUN@@ @@REPO@@/cli.ts send $ARGUMENTS\`
`;

describe("renderCommand", () => {
  test("substitutes the interpreter and checkout, every occurrence", () => {
    const out = renderCommand(TPL, { bun: "/opt/bun/bin/bun", repo: "/srv/claude-peers-mcp" });
    expect(out).toContain("allowed-tools: Bash(/opt/bun/bin/bun /srv/claude-peers-mcp/cli.ts:*)");
    expect(out).toContain("!`/opt/bun/bin/bun /srv/claude-peers-mcp/cli.ts send $ARGUMENTS`");
    expect(out).not.toContain("@@");
  });

  test("strips a trailing slash from the checkout path", () => {
    // update's repoDir comes from new URL("./", …) and ends in "/", which
    // would otherwise render "…/claude-peers-mcp//cli.ts"
    const out = renderCommand(TPL, { bun: "/b/bun", repo: "/home/jason/claude-peers-mcp/" });
    expect(out).toContain("/home/jason/claude-peers-mcp/cli.ts");
    expect(out).not.toContain("//cli.ts");
  });

  test("rejects a relative checkout path", () => {
    // A slash command runs in whatever directory the session is in, so a
    // relative path would resolve somewhere else on every invocation
    expect(() => renderCommand(TPL, { bun: "bun", repo: "./claude-peers-mcp" })).toThrow(/absolute/);
  });

  test("leaves an unknown placeholder visible rather than shipping it blank", () => {
    const out = renderCommand("x @@WAT@@ y", { bun: "/b", repo: "/r" });
    expect(out).toBe("x @@WAT@@ y");
  });
});

describe("commandAction", () => {
  test("missing file is an install", () => {
    expect(commandAction(null, "body")).toBe("installed");
  });

  test("identical content is left alone", () => {
    expect(commandAction("body", "body")).toBe("unchanged");
  });

  test("different content is a refresh", () => {
    expect(commandAction("old", "body")).toBe("refreshed");
  });
});

describe("summarizeInstall", () => {
  test("reports nothing to do as a count", () => {
    const r = [
      { name: "peer-send", action: "unchanged" as const },
      { name: "peer-list", action: "unchanged" as const },
    ];
    expect(summarizeInstall(r)).toBe("commands: up to date (2)");
  });

  test("names what was installed and counts what was refreshed", () => {
    const r = [
      { name: "peer-send", action: "installed" as const },
      { name: "peer-list", action: "refreshed" as const },
      { name: "peer-log", action: "refreshed" as const },
      { name: "peer-iam", action: "unchanged" as const },
    ];
    expect(summarizeInstall(r)).toBe("commands: installed peer-send; refreshed 2");
  });

  test("names every install, so a new machine shows the whole set", () => {
    const r = [
      { name: "peer-send", action: "installed" as const },
      { name: "peer-list", action: "installed" as const },
    ];
    expect(summarizeInstall(r)).toBe("commands: installed peer-send, peer-list");
  });

  test("handles an empty commands dir without claiming success", () => {
    expect(summarizeInstall([])).toBe("commands: none found in the checkout");
  });
});
