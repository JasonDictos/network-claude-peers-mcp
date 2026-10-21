---
description: Send a message to your claude-peers group, or to every session
argument-hint: [group] <message>
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-broadcast.md in the claude-peers-mcp checkout — edit it there, not here. -->

Broadcast result:

!`@@BUN@@ @@REPO@@/cli.ts broadcast - <<'PEER_MSG_EOF'
$ARGUMENTS
PEER_MSG_EOF`

Confirm to the user in one line who received the broadcast (names and directories from the output above). If there were no peers, say so. Subagent peers are skipped by design — each session gets the message once, via its primary.

If this session belongs to exactly one peer group, the broadcast goes to that group rather than the whole machine, and the output names it. If it belongs to several, the command asks which one — pass it as the first argument (`/peer-broadcast <group> <message>`).
