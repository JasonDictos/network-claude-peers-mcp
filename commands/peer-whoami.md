---
description: Show this session's claude-peers identity (name, ID, cwd)
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-whoami.md in the claude-peers-mcp checkout — edit it there, not here. -->

Peer identity of this session:

!`@@BUN@@ @@REPO@@/cli.ts whoami`

Report the identity above to the user in one line (name, ID, directory). If it says the session isn't registered, explain that the MCP server needs a restart (e.g. `/mcp` reconnect or a new session) to register with the broker, and that the broker may be down (`@@BUN@@ @@REPO@@/cli.ts status` to check).
