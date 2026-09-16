---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon (unix socket + TCP; `CLAUDE_PEERS_BIND` opens it to other machines, which requires a token) + SQLite. Auto-launched by the MCP server. Assigns each peer a unique human-readable name (`goofy-joe`) and resolves message targets (ID, name, or directory path).
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/names.ts` — Adjective-noun name generation.
- `shared/resolve.ts` — Pure target-resolution logic (host prefix → ID → name → path, with ambiguity reporting).
- `shared/config.ts` — Network config (broker URL, token, bind) from env or `~/.claude-peers.json`.
- `shared/hosts.ts` — Hostname matching (short/FQDN/IP), DNS resolution, local address discovery.
- `shared/client.ts` — Broker transport: remote URL → unix socket → localhost TCP.
- `shared/summarize.ts` — Auto-summary generation via gpt-5.4-nano.
- `cli.ts` — CLI utility for inspecting broker state. Also provides `whoami` and `statusline` (identifies the calling session by walking ancestor PIDs to match the peer's `claude_pid`).

## Running

Load this server exactly once per session. The channel entry that authorizes
push depends on how it was loaded, and the two forms are not interchangeable:

```bash
# Installed as a plugin (mcpServers in plugin.json):
claude --channels plugin:<plugin>@<marketplace>

# Configured in .claude.json / .mcp.json — a development entry, so it needs
# the development flag; plain --channels rejects it and drops every push:
claude --dangerously-load-development-channels server:claude-peers
```

A repo-local `.mcp.json` on top of a user-scope or plugin install loads the
server twice: the session registers as two peers (the second named as a
subagent, `<name>-1`), and only one of them is the one Claude Code pushes to.
`.mcp.json` is gitignored for that reason — don't commit one.

```bash
# CLI:
bun cli.ts status
bun cli.ts peers [hostname]
bun cli.ts send <name|id|path> <message>
bun cli.ts whoami
bun cli.ts iam <name>   # rename this session's peer
bun cli.ts statusline   # for statusLine in ~/.claude/settings.json
bun cli.ts log -f          # full message text; run as a background task for ctrl-b
bun cli.ts network-setup   # cross-machine peering (hub) / --client <host> --token <t>
bun cli.ts kill-broker
```

Peer names are globally unique across all machines (the hub broker issues them), so a
name is a complete address. Only paths need host qualification: `archiver:~/tools`.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
