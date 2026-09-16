import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { adoptOrphanedMail } from "./mailbox.ts";

const HOST = "jason-desktop";
const CWD = "/home/jason/een-ports";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT NOT NULL,
    sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
    from_name TEXT NOT NULL DEFAULT '', to_name TEXT NOT NULL DEFAULT '',
    to_host TEXT, to_cwd TEXT)`);
});

function put(to_name: string, opts: Partial<{ delivered: number; to_host: string | null; to_cwd: string | null }> = {}) {
  db.run(
    `INSERT INTO messages (from_id, to_id, text, sent_at, delivered, from_name, to_name, to_host, to_cwd)
     VALUES ('f','t','hi','2026-09-16T00:00:00Z',?,'sender',?,?,?)`,
    [
      opts.delivered ?? 0,
      to_name,
      opts.to_host === undefined ? HOST : opts.to_host,
      opts.to_cwd === undefined ? CWD : opts.to_cwd,
    ]
  );
}

const namesNow = () =>
  (db.query("SELECT to_name FROM messages ORDER BY id").all() as { to_name: string }[]).map((r) => r.to_name);

describe("adoptOrphanedMail", () => {
  // The bug this exists for: a session came back as -dude after being -dudette,
  // which moved its mailbox key and stranded mail nothing would ever select.
  test("adopts mail left for a dead earlier name of the same directory", () => {
    put("een-ports-dudette");
    const n = adoptOrphanedMail(db, { host: HOST, cwd: CWD, name: "een-ports-dude", heldByLivePeers: [] });
    expect(n).toBe(1);
    expect(namesNow()).toEqual(["een-ports-dude"]);
  });

  test("never takes mail addressed to a name a live peer still holds", () => {
    put("een-ports-dudette");
    const n = adoptOrphanedMail(db, {
      host: HOST,
      cwd: CWD,
      name: "een-ports-dude",
      heldByLivePeers: ["een-ports-dudette"],
    });
    expect(n).toBe(0);
    expect(namesNow()).toEqual(["een-ports-dudette"]);
  });

  test("leaves already-delivered mail alone", () => {
    put("een-ports-dudette", { delivered: 1 });
    expect(adoptOrphanedMail(db, { host: HOST, cwd: CWD, name: "een-ports-dude", heldByLivePeers: [] })).toBe(0);
    expect(namesNow()).toEqual(["een-ports-dudette"]);
  });

  test("does not reach into another directory", () => {
    put("libeen-cpp-guy", { to_cwd: "/home/jason/libeen-cpp" });
    expect(adoptOrphanedMail(db, { host: HOST, cwd: CWD, name: "een-ports-dude", heldByLivePeers: [] })).toBe(0);
    expect(namesNow()).toEqual(["libeen-cpp-guy"]);
  });

  test("does not reach onto another host with the same path", () => {
    put("een-ports-dude", { to_host: "archiver" });
    expect(adoptOrphanedMail(db, { host: HOST, cwd: CWD, name: "een-ports-dude", heldByLivePeers: [] })).toBe(0);
  });

  test("is a no-op for mail already addressed to us", () => {
    put("een-ports-dude");
    expect(adoptOrphanedMail(db, { host: HOST, cwd: CWD, name: "een-ports-dude", heldByLivePeers: [] })).toBe(0);
    expect(namesNow()).toEqual(["een-ports-dude"]);
  });

  test("ignores rows with no mailbox name (legacy id-addressed mail)", () => {
    put("");
    expect(adoptOrphanedMail(db, { host: HOST, cwd: CWD, name: "een-ports-dude", heldByLivePeers: [] })).toBe(0);
    expect(namesNow()).toEqual([""]);
  });

  test("adopts several strandings at once, sparing the live sibling", () => {
    put("een-ports-dude-2");
    put("een-ports-dudette");
    put("een-ports-sibling");
    const n = adoptOrphanedMail(db, {
      host: HOST,
      cwd: CWD,
      name: "een-ports-dude",
      heldByLivePeers: ["een-ports-sibling"],
    });
    expect(n).toBe(2);
    expect(namesNow()).toEqual(["een-ports-dude", "een-ports-dude", "een-ports-sibling"]);
  });
});
