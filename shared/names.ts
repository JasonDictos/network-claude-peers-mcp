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

/**
 * Names are scoped to the repository a session works in, so the name itself
 * says what the peer is for and is easy to type: libeen-cpp-dude,
 * archiver-tools-dudette. Gender is picked at random per session; collisions
 * inside one repo take the other token, then a low number.
 */
export const PERSON_TOKENS = ["dude", "dudette"] as const;

/** Repo (or directory) a session belongs to, as a name-safe token. */
export function repoBase(cwd: string, gitRoot: string | null): string {
  const path = (gitRoot ?? cwd).replace(/\/+$/, "");
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const clean = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "peer";
}

/**
 * A repo-scoped name: <repo>-dude / <repo>-dudette, then -2..-10 for further
 * sessions in the same repo, and finally <repo>-<adjective>-<noun> if even
 * those are taken — so a name is always available and always says its scope.
 */
export function scopedName(base: string, taken: Set<string>): string {
  const order =
    Math.random() < 0.5
      ? [PERSON_TOKENS[0], PERSON_TOKENS[1]]
      : [PERSON_TOKENS[1], PERSON_TOKENS[0]];

  for (const token of order) {
    const name = `${base}-${token}`;
    if (!taken.has(name)) return name;
  }
  // Low digits: nobody runs more than a handful of sessions per repo
  for (let i = 2; i <= 10; i++) {
    for (const token of order) {
      const name = `${base}-${token}-${i}`;
      if (!taken.has(name)) return name;
    }
  }
  // Fall back to the adjective-noun pool, still repo-scoped
  for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
    const name = `${base}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  for (const a of ADJECTIVES) {
    for (const noun of NOUNS) {
      const name = `${base}-${a}-${noun}`;
      if (!taken.has(name)) return name;
    }
  }
  return `${base}-${generateName(taken)}`;
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
