---
description: List Claude Code peers on the network (optionally one hostname)
argument-hint: [hostname]
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-list.md in the claude-peers-mcp checkout — edit it there, not here. -->

Current peers on the claude-peers network:

!`@@BUN@@ @@REPO@@/cli.ts peers $ARGUMENTS`

Present the peers above as a compact table: name, ID, machine, directory, and summary (if any). Peers on another machine are shown as name@host. Note which one is likely this session (matching cwd), if identifiable. If the broker is not running, say so.
