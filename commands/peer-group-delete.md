---
description: Delete a claude-peers group (the peers themselves are untouched)
argument-hint: <name>
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-group-delete.md in the claude-peers-mcp checkout — edit it there, not here. -->

Delete result:

!`@@BUN@@ @@REPO@@/cli.ts group rm $ARGUMENTS`

Only the group name goes away; its members keep running and stay addressable by name. Report the result in one line. If there was no such group, say so and offer `/peer-group-list`.
