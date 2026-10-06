---
description: Rename this session's claude-peers name (e.g. /peer-iam archiver-guy)
argument-hint: <name>
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-iam.md in the claude-peers-mcp checkout — edit it there, not here. -->

Rename result:

!`@@BUN@@ @@REPO@@/cli.ts iam $ARGUMENTS`

Confirm the rename to the user in one line (old name -> new name). If it failed because the name is taken, say who has it. If the session couldn't be identified, explain the MCP server may need a reconnect (`/mcp`) so the peer is registered with this session's process.
