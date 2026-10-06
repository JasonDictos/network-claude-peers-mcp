---
description: Send a message to all claude-peers sessions on this machine
argument-hint: <message>
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-broadcast.md in the claude-peers-mcp checkout — edit it there, not here. -->

Broadcast result:

!`@@BUN@@ @@REPO@@/cli.ts broadcast - <<'PEER_MSG_EOF'
$ARGUMENTS
PEER_MSG_EOF`

Confirm to the user in one line who received the broadcast (names and directories from the output above). If there were no peers, say so. Subagent peers are skipped by design — each session gets the message once, via its primary.
