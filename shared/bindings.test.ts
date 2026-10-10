import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { boundName } from "./bindings.ts";

const HOST = "jason-desktop";
const CWD = "/home/jason/raposa/raposa-custodian";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE name_bindings (
    host TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (host, cwd))`);
});

const bind = (host: string, cwd: string, name: string) =>
  db.run("INSERT INTO name_bindings (host, cwd, name, updated_at) VALUES (?,?,?,?)", [
    host, cwd, name, "2026-10-06T00:00:00Z",
  ]);

describe("boundName", () => {
  // The case this exists for: the bar renders in the ~3s before the peer
  // registers, so there is no live peer to match, but the name is known.
  test("returns the name bound to this directory", () => {
    bind(HOST, CWD, "raposa-bot");
    expect(boundName(db, HOST, CWD)).toBe("raposa-bot");
  });

  test("null when the directory has no binding", () => {
    expect(boundName(db, HOST, "/home/jason/somewhere-new")).toBeNull();
  });

  test("null for a binding that belongs to another host", () => {
    bind("archiver", CWD, "raposa-custodian");
    expect(boundName(db, HOST, CWD)).toBeNull();
  });

  // A co-resident session holding the sticky name means this one will be given
  // a different name, so showing the bound name would name the wrong session.
  test("null when a live peer already holds the bound name", () => {
    bind(HOST, CWD, "raposa-bot");
    expect(boundName(db, HOST, CWD, ["raposa-bot"])).toBeNull();
  });

  test("still returns it when other, unrelated names are held", () => {
    bind(HOST, CWD, "raposa-bot");
    expect(boundName(db, HOST, CWD, ["feisty-joe", "spiffy-gus"])).toBe("raposa-bot");
  });

  test("accepts a Set as well as an array", () => {
    bind(HOST, CWD, "raposa-bot");
    expect(boundName(db, HOST, CWD, new Set(["raposa-bot"]))).toBeNull();
    expect(boundName(db, HOST, CWD, new Set<string>())).toBe("raposa-bot");
  });

  test("exact cwd only — a parent directory's binding does not apply", () => {
    bind(HOST, "/home/jason/raposa", "nifty-pearl");
    expect(boundName(db, HOST, CWD)).toBeNull();
  });
});
