# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Discord bot that bridges Discord threads to Claude Code CLI sessions, letting developers interact with their codebase remotely from any device. See `PRD.md` for the full product specification.

## Planned Tech Stack

- **Runtime:** Node.js 20+ with TypeScript
- **Discord:** discord.js v14 (slash commands, threads, embeds, button interactions)
- **Process management:** node-pty (pseudo-terminal for Claude Code subprocess capture)
- **Config:** cosmiconfig (`~/.discord-claude/config.json` or per-project `.discord-claude.json`)
- **Logging:** pino
- **Process supervisor:** pm2 or systemd

## Architecture

The bot has three main layers:

1. **Discord layer** — receives slash commands and thread messages, sends/edits messages and embeds. Each `/claude <prompt>` call creates a new Discord thread that owns one session.

2. **Session manager** — maps Discord thread IDs to running Claude Code processes. Responsible for lifecycle (spawn, stream, terminate) and enforcing `maxConcurrentSessions` / `maxSessionDuration`.

3. **Process layer** — spawns `claude` CLI via node-pty (not `child_process.spawn`) so that Claude Code's terminal output is captured correctly. Buffers stdout chunks and flushes to Discord on a ~1.5 s interval to stay within Discord's rate limit (5 edits / 5 s per message). When a message hits Discord's 2000-char limit, the current message is finalized and a new one is started.

### Key design constraints from the PRD

- **Thread = session**: one Discord thread ↔ one Claude Code process. Thread ID is the session key.
- **Streaming via message editing**: bot sends an initial message then edits it as output accumulates; a ✅ reaction signals completion.
- **Secret redaction**: all output must be filtered through configurable regex patterns before being sent to Discord (default patterns: `sk-[a-zA-Z0-9]+`, `ghp_[a-zA-Z0-9]+`, `AKIA[A-Z0-9]+`).
- **Approval gates**: destructive file operations surface a Discord embed with ✅/❌ reactions before proceeding (configurable `autoApprove`; file deletions always require approval).
- **Command allowlist**: `/run` only executes commands in the project config's `allowedShellCommands` list.
- **Audit log**: all commands and Claude Code invocations must be logged with user, timestamp, and working directory.

## Configuration shape

```jsonc
// ~/.discord-claude/config.json  (global, merged with per-project .discord-claude.json)
{
  "global": {
    "allowedRoles": ["developer", "admin"],
    "maxConcurrentSessions": 5,
    "maxSessionDuration": 3600,
    "secretPatterns": ["sk-[a-zA-Z0-9]+", "ghp_[a-zA-Z0-9]+", "AKIA[A-Z0-9]+"]
  },
  "projects": {
    "<name>": {
      "path": "/abs/path/to/repo",
      "commands": { "test": "...", "build": "...", "lint": "...", "typecheck": "npx tsc --noEmit" },
      "autoApprove": false,
      "allowedShellCommands": ["npm", "npx", "node", "git", "cat", "ls", "grep"]
    }
  }
}
```

## Development phases (from PRD)

| Phase | Scope |
|-------|-------|
| 1 | `/claude`, streaming, session management, RBAC |
| 2 | `/file`, `/tree`, `/diff`, `/git *`, secret redaction |
| 3 | `/run`, `/test`, `/build`, `/lint`, project switching |
| 4 | Mobile polish: buttons, image attachments, DM mode |
| 5 | `/watch`, `/schedule`, snippets, approval gates |
