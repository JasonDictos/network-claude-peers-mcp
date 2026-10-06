---
description: Send a message to one claude-peers session by name, ID, or path
argument-hint: <name|id|path> <message>
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-send.md in the claude-peers-mcp checkout — edit it there, not here. -->

Send result:

!`{ IFS= read -r line; rest=$(cat); t=${line%% *}; if [ "$t" = "$line" ]; then m=""; else m=${line#* }; fi; if [ -n "$rest" ]; then printf '%s\n%s' "$m" "$rest"; else printf '%s' "$m"; fi | @@BUN@@ @@REPO@@/cli.ts send "$t" -; } <<'PEER_MSG_EOF'
$ARGUMENTS
PEER_MSG_EOF`

The first whitespace-separated token of the arguments is the target; everything after it is the message.

Report in one line whether it was delivered and to whom. If the output says the message was queued or the recipient is marked no-push, say so plainly — that means the recipient's session has no channel listener, so it will only see the message via check_messages rather than as a push. If it says no peer matches, show the candidate names from the output so the user can pick one.
