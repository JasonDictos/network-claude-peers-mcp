/**
 * Human-readable peer names: adjective-noun pairs like "goofy-joe".
 * Unique among live peers; a name frees up when its peer dies.
 */

export const ADJECTIVES = [
  "goofy", "eager", "sleepy", "zippy", "mellow", "snazzy", "perky", "dizzy",
  "jolly", "crafty", "breezy", "spunky", "witty", "groovy", "peppy", "quirky",
  "sassy", "cheeky", "dandy", "feisty", "giddy", "jaunty", "lively", "merry",
  "nifty", "plucky", "rowdy", "spiffy", "sturdy", "swift", "tidy", "zesty",
] as const;

export const NOUNS = [
  "joe", "eddy", "max", "ruby", "otis", "wanda", "felix", "hazel",
  "gus", "lola", "rex", "mabel", "ziggy", "pearl", "bruno", "daisy",
  "hank", "iris", "jasper", "kiki", "louie", "molly", "ned", "olive",
  "pablo", "quinn", "rosie", "sam", "tilly", "vito", "wally", "zelda",
] as const;

const MAX_RANDOM_ATTEMPTS = 100;

/** Repo (or directory) a session belongs to, as a name-safe token. */
export function repoBase(cwd: string, gitRoot: string | null): string {
  const path = (gitRoot ?? cwd).replace(/\/+$/, "");
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const clean = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "peer";
}

/**
 * A repo-scoped name: the repo or directory itself, then -2, -3 for further
 * sessions in the same place. Numbers start at 2 so -1 stays free for the
 * session's first agent peer, and a name is always available.
 */
export function scopedName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}-${i}`;
    if (!taken.has(name)) return name;
  }
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Name for an agent peer of an existing session: base-1, base-2, ... */
export function childName(base: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = `${base}-${n}`;
    if (!taken.has(name)) return name;
  }
}

export function generateName(taken: Set<string>): string {
  for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
    const name = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  // Random attempts exhausted — scan for any free combo
  for (const a of ADJECTIVES) {
    for (const n of NOUNS) {
      const name = `${a}-${n}`;
      if (!taken.has(name)) return name;
    }
  }
  // Every combo taken — append a numeric suffix
  const base = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`;
    if (!taken.has(name)) return name;
  }
}
