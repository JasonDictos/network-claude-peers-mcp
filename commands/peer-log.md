---
description: Show recent claude-peers messages, full text, with sender names
argument-hint: [count]
allowed-tools: Bash(@@BUN@@ @@REPO@@/cli.ts:*)
---

<!-- Installed by `bun cli.ts update` from commands/peer-log.md in the claude-peers-mcp checkout — edit it there, not here. -->

Recent peer messages (full, untruncated):

!`@@BUN@@ @@REPO@@/cli.ts log -n $ARGUMENTS`

Show the messages above to the user verbatim in a code block (do not summarize or truncate). If the user wants a live feed, offer to run `@@BUN@@ @@REPO@@/cli.ts log -f` as a background task so they can watch it with ctrl-b.
