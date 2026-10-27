---
description: Create a claude-peers group, or replace the members of one
argument-hint: <name> <peer> [peer...]
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-group-create.md in the claude-peers-mcp checkout — edit it there, not here. -->

Group created:

!`@@BUN@@ @@REPO@@/cli.ts group $ARGUMENTS`

Membership is replaced wholesale, so this also edits an existing group. A member may be a peer name, a directory path, or the name of another group — a nested group contributes its members at send time, so the parent keeps up as the child changes.

Report the group and its members in one line, then tell the user they can send to it by name: `/peer-send <group> <message>` delivers one copy to each member, and a broadcast from a member stays inside the group. If the output lists members matching no peer or mailbox, name them: it is usually a typo in a peer name. If the name was refused for colliding with a peer, say which peer has it.
