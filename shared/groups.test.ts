import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  groupNameError,
  dedupeSessions,
  broadcastScope,
  isVisibleTo,
  createGroupTable,
  setGroup,
  groupMembers,
  listGroups,
  deleteGroup,
  membershipsOf,
} from "./groups.ts";
import type { Peer } from "./types.ts";

function peer(over: Partial<Peer> & { id: string }): Peer {
  return {
    name: over.id,
    pid: 100,
    claude_pid: null,
    claude_key: null,
    runtime: null,
    host: "desktop",
    push_enabled: 1,
    cwd: `/home/jason/${over.id}`,
    git_root: null,
    tty: null,
    summary: "",
    registered_at: "2026-10-21T00:00:00.000Z",
    last_seen: "2026-10-21T00:00:00.000Z",
    ...over,
  };
}

describe("groupNameError", () => {
  test("accepts a plain name", () => {
    expect(groupNameError("team-win")).toBeNull();
  });

  test("rejects an empty name", () => {
    expect(groupNameError("")).toBeTruthy();
  });

  test("rejects whitespace, which would split into two arguments", () => {
    expect(groupNameError("team win")).toBeTruthy();
  });

  test("rejects path and host punctuation, which addresses peers", () => {
    expect(groupNameError("~/team")).toBeTruthy();
    expect(groupNameError("archiver:team")).toBeTruthy();
    expect(groupNameError("team@desktop")).toBeTruthy();
  });

  test("rejects the subcommand words, which would be unaddressable", () => {
    expect(groupNameError("rm")).toBeTruthy();
    expect(groupNameError("ls")).toBeTruthy();
  });
});

describe("dedupeSessions", () => {
  test("keeps one peer per session", () => {
    const a = peer({ id: "aaa", claude_key: "7:1" });
    const same = peer({ id: "bbb", claude_key: "7:1" });
    expect(dedupeSessions([a, same]).map((p) => p.id)).toEqual(["aaa"]);
  });

  test("keeps the member named first when a session is named twice", () => {
    const agent = peer({ id: "bbb", name: "repo-1", claude_key: "7:1" });
    const primary = peer({ id: "aaa", name: "repo", claude_key: "7:1" });
    expect(dedupeSessions([agent, primary]).map((p) => p.name)).toEqual(["repo-1"]);
  });

  test("keeps peers on different machines that share a pid", () => {
    const here = peer({ id: "aaa", host: "desktop", claude_key: "7:1" });
    const there = peer({ id: "bbb", host: "home", claude_key: "7:1" });
    expect(dedupeSessions([here, there]).map((p) => p.id)).toEqual(["aaa", "bbb"]);
  });

  test("keeps sessionless peers apart", () => {
    const a = peer({ id: "aaa" });
    const b = peer({ id: "bbb" });
    expect(dedupeSessions([a, b]).map((p) => p.id)).toEqual(["aaa", "bbb"]);
  });

  test("drops a peer listed twice by id", () => {
    const a = peer({ id: "aaa" });
    expect(dedupeSessions([a, a]).map((p) => p.id)).toEqual(["aaa"]);
  });
});

describe("broadcastScope", () => {
  test("reaches every peer when the sender is in no group", () => {
    expect(broadcastScope([], null)).toEqual({ kind: "all" });
  });

  test("stays inside the sender's only group", () => {
    expect(broadcastScope(["team-win"], null)).toEqual({ kind: "group", name: "team-win" });
  });

  test("asks which group when the sender is in several", () => {
    expect(broadcastScope(["team-win", "nightshift"], null)).toEqual({
      kind: "ambiguous",
      groups: ["team-win", "nightshift"],
    });
  });

  test("honours a named group, even one the sender is not in", () => {
    expect(broadcastScope([], "team-win")).toEqual({ kind: "group", name: "team-win" });
    expect(broadcastScope(["nightshift"], "team-win")).toEqual({
      kind: "group",
      name: "team-win",
    });
  });
});

describe("isVisibleTo", () => {
  const viewer = { id: "aaa", name: "repo", host: "desktop", cwd: "/home/jason/repo" };
  const msg = {
    from_id: "zzz",
    from_name: "other",
    to_id: "bbb",
    to_name: "elsewhere",
    to_host: "desktop",
    to_cwd: "/home/jason/elsewhere",
  };

  test("the sender sees its own message", () => {
    expect(isVisibleTo({ ...msg, from_id: "aaa" }, viewer)).toBe(true);
  });

  test("an earlier registration's send is still the sender's own", () => {
    expect(isVisibleTo({ ...msg, from_id: "old", from_name: "repo" }, viewer)).toBe(true);
  });

  test("the recipient sees it", () => {
    expect(isVisibleTo({ ...msg, to_id: "aaa" }, viewer)).toBe(true);
  });

  test("a recipient addressed while offline sees it by mailbox", () => {
    const queued = { ...msg, to_id: "", to_name: "repo", to_cwd: "/home/jason/repo" };
    expect(isVisibleTo(queued, viewer)).toBe(true);
  });

  test("the same name on another machine is a different mailbox", () => {
    const queued = { ...msg, to_id: "", to_name: "repo", to_cwd: "/home/jason/repo", to_host: "home" };
    expect(isVisibleTo(queued, viewer)).toBe(false);
  });

  test("a peer that is party to neither end sees nothing", () => {
    expect(isVisibleTo(msg, viewer)).toBe(false);
  });
});

describe("group storage", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    createGroupTable(db);
  });

  test("creating the table twice is harmless", () => {
    createGroupTable(db);
    expect(listGroups(db)).toEqual([]);
  });

  test("keeps members in the order they were given", () => {
    setGroup(db, "team-win", ["dhash-daemon", "~/archiver", "home:"]);
    expect(groupMembers(db, "team-win")).toEqual(["dhash-daemon", "~/archiver", "home:"]);
  });

  test("replaces the whole membership", () => {
    setGroup(db, "team-win", ["a", "b"]);
    setGroup(db, "team-win", ["c"]);
    expect(groupMembers(db, "team-win")).toEqual(["c"]);
  });

  test("addresses a group case-insensitively", () => {
    setGroup(db, "Team-Win", ["a"]);
    expect(groupMembers(db, "team-win")).toEqual(["a"]);
    expect(listGroups(db)[0]!.name).toBe("team-win");
  });

  test("tells an unknown group from an empty one", () => {
    expect(groupMembers(db, "nope")).toBeNull();
  });

  test("lists groups by name with their members", () => {
    setGroup(db, "nightshift", ["c"]);
    setGroup(db, "team-win", ["a", "b"]);
    expect(listGroups(db)).toEqual([
      { name: "nightshift", members: ["c"] },
      { name: "team-win", members: ["a", "b"] },
    ]);
  });

  test("deleting reports whether there was anything to delete", () => {
    setGroup(db, "team-win", ["a"]);
    expect(deleteGroup(db, "team-win")).toBe(true);
    expect(deleteGroup(db, "team-win")).toBe(false);
    expect(listGroups(db)).toEqual([]);
  });
});

describe("membershipsOf", () => {
  const home = "/home/jason";
  const daemon = peer({ id: "aaa", name: "dhash-daemon", cwd: "/home/jason/dhash-daemon" });
  const archiver = peer({ id: "bbb", name: "archiver2", cwd: "/home/jason/archiver" });
  const outsider = peer({ id: "ccc", name: "libeen-cpp" });
  const peers = [daemon, archiver, outsider];

  test("counts a peer named in the group", () => {
    const groups = [{ name: "team-win", members: ["dhash-daemon"] }];
    expect(membershipsOf(groups, daemon, peers, home)).toEqual(["team-win"]);
  });

  test("counts a peer the group addresses by path", () => {
    const groups = [{ name: "team-win", members: ["~/archiver"] }];
    expect(membershipsOf(groups, archiver, peers, home)).toEqual(["team-win"]);
  });

  test("counts an agent of a member session", () => {
    const primary = peer({ id: "aaa", name: "repo", claude_key: "7:1" });
    const agent = peer({ id: "zzz", name: "repo-1", claude_key: "7:1" });
    const groups = [{ name: "team-win", members: ["repo"] }];
    expect(membershipsOf(groups, agent, [primary, agent], home)).toEqual(["team-win"]);
  });

  test("leaves a peer outside every group with nothing", () => {
    const groups = [{ name: "team-win", members: ["dhash-daemon", "~/archiver"] }];
    expect(membershipsOf(groups, outsider, peers, home)).toEqual([]);
  });

  test("reports every group a peer is in", () => {
    const groups = [
      { name: "nightshift", members: ["dhash-daemon"] },
      { name: "team-win", members: ["dhash-daemon", "archiver2"] },
    ];
    expect(membershipsOf(groups, daemon, peers, home)).toEqual(["nightshift", "team-win"]);
  });
});
