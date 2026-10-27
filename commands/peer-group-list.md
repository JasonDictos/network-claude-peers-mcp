---
description: List the claude-peers groups and who is in each
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-group-list.md in the claude-peers-mcp checkout — edit it there, not here. -->

Groups:

!`@@BUN@@ @@REPO@@/cli.ts group`

Show each group and its members in one line per group. A member may itself be the name of another group, which means that group's members too. If there are none, say so and show how to make one: `/peer-group-create <name> <peer> <peer> ...`.
