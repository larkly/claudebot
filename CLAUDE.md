# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Discord Claude Code Bot** — a Discord bot that bridges Discord threads to Claude Code CLI sessions, letting developers interact with their codebase remotely from any device. See `PRD.md` for the full product specification and `PROCESS.md` for the development methodology.

## Current Status

**Pre-implementation / Design phase.** The repository currently contains only documentation:

```
claudebot/
├── CLAUDE.md       ← This file (AI assistant guidance)
├── PRD.md          ← Product requirements document (detailed feature specs)
└── PROCESS.md      ← Development process pipeline (10-stage methodology)
```

No source code, build tooling, tests, or CI/CD exists yet. All technical decisions and architecture are documented but not yet implemented.

## Planned Tech Stack

| Component          | Choice          | Purpose                                                    |
|--------------------|-----------------|------------------------------------------------------------|
| Runtime            | Node.js 20+     | Application runtime                                        |
| Language           | TypeScript       | Type safety across the codebase                            |
| Discord library    | discord.js v14   | Slash commands, threads, embeds, button interactions        |
| Process management | node-pty         | Pseudo-terminal for Claude Code subprocess output capture   |
| Configuration      | cosmiconfig      | Hierarchical config: global + per-project overrides         |
| Logging            | pino             | Structured logging for audit trail                         |
| Process supervisor | pm2 or systemd   | Keep the bot alive across restarts                         |

## Architecture

Three layers:

1. **Discord layer** — Receives slash commands and thread messages, sends/edits messages and embeds. Each `/claude <prompt>` call creates a new Discord thread that owns one session.

2. **Session manager** — Maps Discord thread IDs to running Claude Code processes. Handles lifecycle (spawn, stream, terminate) and enforces `maxConcurrentSessions` / `maxSessionDuration`.

3. **Process layer** — Spawns `claude` CLI via node-pty (not `child_process.spawn`) for proper terminal output capture. Buffers stdout and flushes to Discord on a ~1.5s interval to stay within Discord's rate limit (5 edits / 5s per message). When a message hits Discord's 2000-char limit, the current message is finalized and a new one is started.

### Key Design Constraints

- **Thread = session**: One Discord thread maps to exactly one Claude Code process. Thread ID is the session key.
- **Streaming via message editing**: Bot sends an initial message then edits it as output accumulates; a ✅ reaction signals completion.
- **Secret redaction**: All output filtered through configurable regex patterns before reaching Discord (defaults: `sk-[a-zA-Z0-9]+`, `ghp_[a-zA-Z0-9]+`, `AKIA[A-Z0-9]+`).
- **Approval gates**: Destructive file operations surface a Discord embed with ✅/❌ reactions. File deletions always require approval regardless of `autoApprove` config.
- **Command allowlist**: `/run` only executes commands matching the `allowedShellCommands` list.
- **Audit log**: All commands and invocations logged with user, timestamp, and working directory.

## Configuration Schema

Two-level config: global (`~/.discord-claude/config.json`) merged with per-project (`.discord-claude.json`).

```jsonc
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

## Development Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `/claude`, streaming output, session management, RBAC | Not started |
| 2 | `/file`, `/tree`, `/diff`, `/git *`, secret redaction | Not started |
| 3 | `/run`, `/test`, `/build`, `/lint`, project switching | Not started |
| 4 | Mobile polish: buttons, image attachments, DM mode | Not started |
| 5 | `/watch`, `/schedule`, snippets, approval gates | Not started |

## Development Process

Follow the 10-stage pipeline defined in `PROCESS.md`:

1. Idea → 2. Crystallized Brief → 3. First-Principles Design → 4. Adversarial Review → 5. Design Iteration → 6. Atomic Planning → 7. Parallel Build → 8. Build Validation → 9. QA Pipeline → 10. Security Review

The process is non-linear — any stage can loop back to an earlier one. Front-load design work; time spent thinking is cheaper than time spent rewriting.

## Conventions and Guidelines

### When Building (Phase 1 setup and beyond)

- **TypeScript strict mode** — enable `strict: true` in tsconfig.json.
- **ES modules** — use `"type": "module"` in package.json.
- **Naming**: camelCase for config keys and variables, kebab-case for slash commands (`/claude-end`), PascalCase for classes and types.
- **Logging**: Use pino with structured fields. Every command and Claude Code invocation must include `user`, `timestamp`, and `workingDirectory` in the audit log. This is the only production visibility window for a self-hosted bot.
- **Error handling**: Design for degraded-mode behavior. The bot should recover gracefully, not crash on unexpected input.
- **No secrets in output**: Run redaction through `secretPatterns` regex list before every Discord message write — not after, not sometimes, every time.

### Security-Critical Code Paths

These are the highest-risk areas identified in `PROCESS.md`. Extra scrutiny required:

1. **Streaming buffer → Discord write**: Secret redaction must run before every write. A single miss leaks credentials to a semi-public channel.
2. **`/run` command input → shell execution**: The allowlist must be enforced before execution, not after. Validate the command binary against `allowedShellCommands` before spawning.
3. **`/file` and `/tree` path input → filesystem read**: Prevent path traversal. All paths must resolve within the project root. Reject `..` components and symlinks that escape the jail.

### Testing Requirements

- Discord interaction testing requires a **live bot token** and a **dedicated test guild** — this cannot be fully mocked.
- Set up the test guild before QA runs, not during.
- Minimum test coverage: streaming flow (initial message → edits → ✅ reaction) and approval gate flow (embed → reaction → proceed/cancel).
- Unit tests for each atomic component; integration tests for composed behavior.
- Type checks (`npx tsc --noEmit`) and linting must pass cleanly.

## Key Reference Documents

| Document | Purpose |
|----------|---------|
| `PRD.md` | Full product spec: features, architecture diagram, commands, permissions, mobile UX, deployment options, open questions |
| `PROCESS.md` | Development methodology: 10-stage pipeline, adversarial review checklist, security threat vectors, QA requirements |
| `CLAUDE.md` | This file: quick-reference for AI assistants working in this repo |
