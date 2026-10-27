---
description: List, create or delete a claude-peers group — one name for several peers
argument-hint: [name] [peer...] | rm <name>
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-group.md in the claude-peers-mcp checkout — edit it there, not here. -->

Group result:

!`@@BUN@@ @@REPO@@/cli.ts group $ARGUMENTS`

No arguments lists every group; `<name> <peer> <peer> ...` creates one or replaces its members; `rm <name>` deletes one. `/peer-group-list`, `/peer-group-create` and `/peer-group-delete` do the same three jobs one at a time. A member may be the name of another group, which contributes its members at send time.

Report the group and its members in one line. If it was just created, tell the user they can now send to it by name — `/peer-send <group> <message>` delivers one copy to each member, and a broadcast from a member stays inside the group. If the output lists members matching no peer or mailbox, name them: it is usually a typo in a peer name. If a name was refused for colliding with a peer, say which peer has it.
