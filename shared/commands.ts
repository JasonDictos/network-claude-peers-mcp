/**
 * Slash-command installation.
 *
 * The /peer-* commands live in `commands/*.md` in this repo and are installed
 * into ~/.claude/commands by `bun cli.ts update`. They used to be hand-copied
 * per machine, which drifted silently: a command written on one machine was
 * simply absent on the others, and nothing reported the gap.
 *
 * The templates carry placeholders because a slash command runs through a
 * plain shell with no repo context — the interpreter and the checkout both
 * have to be absolute, and both differ per machine (/home/jason, /home/claude-bot,
 * a container's /home/dev_jason). They are substituted at install time with the
 * paths of the checkout doing the installing.
 */

export const PLACEHOLDER_BUN = "@@BUN@@";
export const PLACEHOLDER_REPO = "@@REPO@@";

export interface CommandVars {
  /** Absolute path to the bun that runs cli.ts (process.execPath). */
  bun: string;
  /** Absolute path to this checkout, with or without a trailing slash. */
  repo: string;
}

/** Fill a `commands/*.md` template in with one machine's paths. */
export function renderCommand(template: string, vars: CommandVars): string {
  if (!vars.repo.startsWith("/")) {
    throw new Error(`checkout path must be absolute, got "${vars.repo}"`);
  }
  const repo = vars.repo.replace(/\/+$/, "");
  return template.replaceAll(PLACEHOLDER_BUN, vars.bun).replaceAll(PLACEHOLDER_REPO, repo);
}

export type CommandAction = "installed" | "refreshed" | "unchanged";

export interface CommandResult {
  name: string;
  action: CommandAction;
}

/** What installing `rendered` over `existing` (null when absent) amounts to. */
export function commandAction(existing: string | null, rendered: string): CommandAction {
  if (existing === null) return "installed";
  return existing === rendered ? "unchanged" : "refreshed";
}

/** One line for update's output: names new commands, counts rewritten ones. */
export function summarizeInstall(results: CommandResult[]): string {
  if (results.length === 0) return "commands: none found in the checkout";

  const installed = results.filter((r) => r.action === "installed").map((r) => r.name);
  const refreshed = results.filter((r) => r.action === "refreshed").length;
  if (installed.length === 0 && refreshed === 0) {
    return `commands: up to date (${results.length})`;
  }

  const parts: string[] = [];
  // Name the installs — on a new machine that is the whole set, and on an old
  // one it is exactly the command that was missing
  if (installed.length) parts.push(`installed ${installed.join(", ")}`);
  if (refreshed) parts.push(`refreshed ${refreshed}`);
  return `commands: ${parts.join("; ")}`;
}
