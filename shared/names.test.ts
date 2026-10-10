import { test, expect, describe } from "bun:test";
import { generateName, childName, scopedName, repoBase, ADJECTIVES, NOUNS } from "./names.ts";

describe("childName", () => {
  test("first agent gets -1", () => {
    expect(childName("goofy-joe", new Set(["goofy-joe"]))).toBe("goofy-joe-1");
  });

  test("skips taken suffixes", () => {
    const taken = new Set(["goofy-joe", "goofy-joe-1", "goofy-joe-2"]);
    expect(childName("goofy-joe", taken)).toBe("goofy-joe-3");
  });
});

describe("generateName", () => {
  test("produces adjective-noun format", () => {
    const name = generateName(new Set());
    const [adj = "", noun = ""] = name.split("-");
    expect(ADJECTIVES as readonly string[]).toContain(adj);
    expect(NOUNS as readonly string[]).toContain(noun);
  });

  test("avoids taken names", () => {
    // Take everything except one specific combo
    const taken = new Set<string>();
    for (const a of ADJECTIVES) {
      for (const n of NOUNS) {
        if (!(a === ADJECTIVES[0] && n === NOUNS[0])) taken.add(`${a}-${n}`);
      }
    }
    const name = generateName(taken);
    expect(name).toBe(`${ADJECTIVES[0]}-${NOUNS[0]}`);
  });

  test("falls back to numeric suffix when all combos are taken", () => {
    const taken = new Set<string>();
    for (const a of ADJECTIVES) {
      for (const n of NOUNS) {
        taken.add(`${a}-${n}`);
      }
    }
    const name = generateName(taken);
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d+$/);
    expect(taken.has(name)).toBe(false);
  });

  test("successive calls with accumulating taken set never collide", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const name = generateName(taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });
});

describe("repoBase", () => {
  test("uses the git repo name, not the subdirectory", () => {
    expect(repoBase("/home/jason/libeen-cpp/src/net", "/home/jason/libeen-cpp")).toBe("libeen-cpp");
  });

  test("falls back to the directory when there is no repo", () => {
    expect(repoBase("/home/jason/scratch-pad", null)).toBe("scratch-pad");
  });

  test("sanitizes to name-safe characters", () => {
    expect(repoBase("/home/jason/My Repo.v2", null)).toBe("my-repo-v2");
  });

  test("survives a trailing slash and an unnameable directory", () => {
    expect(repoBase("/home/jason/libeen/", null)).toBe("libeen");
    expect(repoBase("/", null)).toBe("peer");
  });
});

describe("scopedName", () => {
  test("is just the repo name", () => {
    expect(scopedName("libeen-cpp", new Set())).toBe("libeen-cpp");
  });

  test("a second session in the same repo takes a number", () => {
    expect(scopedName("libeen-cpp", new Set(["libeen-cpp"]))).toBe("libeen-cpp-2");
  });

  test("numbers start at 2, leaving -1 to the primary's first agent", () => {
    const taken = new Set(["libeen-cpp", "libeen-cpp-2"]);
    expect(scopedName("libeen-cpp", taken)).toBe("libeen-cpp-3");
  });

  test("steps over a number an agent peer already holds", () => {
    const taken = new Set(["libeen-cpp", "libeen-cpp-2", "libeen-cpp-3"]);
    expect(scopedName("libeen-cpp", taken)).toBe("libeen-cpp-4");
  });

  test("every generated name is valid for rename validation ([a-z0-9-])", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const name = scopedName("archiver-tools", taken);
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });

  test("carries no person token", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const name = scopedName("een-ports", taken);
      expect(name).not.toMatch(/dude/);
      taken.add(name);
    }
  });
});
