# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project Overview

**Discord Claude Code Bot** — a Discord bot that bridges Discord threads to Claude Code CLI sessions. See `PRD.md` for full product spec, `DESIGN.md` for detailed design decisions and schemas, `PROCESS.md` for development methodology.

## Current Status

**Pre-implementation / Design phase.** No source code, build tooling, tests, or CI/CD exists yet.

## Tech Stack

Node.js 20+ · TypeScript (strict) · discord.js v14 · node-pty · cosmiconfig · pino · pm2/systemd

## Architecture

Three layers:

1. **Discord layer** — slash commands, thread management, message editing, reactions
2. **Session manager** — `Map<string, SessionState>` keyed by thread ID; lifecycle, timeouts, RBAC
3. **Process layer** — spawns `claude` CLI via node-pty with `--output-format stream-json`; first invocation sets `cwd` to project path, subsequent use `--resume <session_id>`

See `DESIGN.md` for `SessionState` schema and stream-json event format.

## Design Decisions

These are decided. Do not relitigate without good reason. See `DESIGN.md` for full rationale and constraints.

- **Conversation continuity**: `--resume` mode. First invocation: `claude -p "<prompt>" --output-format stream-json`. Subsequent: `claude --resume <session_id> -p "<prompt>" --output-format stream-json`. Session ID parsed from `result` event. `cwd` is anchored to first invocation — must be set to the configured project path.
- **Multi-user sessions**: session lock. First user owns the thread session. Others get a message explaining the lock.
- **Natural language fallback**: plain messages in active session threads are forwarded as prompts via `--resume`. Sessions only created via `/claude`.
- **Persistent sessions**: ephemeral processes, but `claudeSessionId` persisted to `~/.discord-claude/active-threads.json`. On restart, `--resume` restores context.
- **Cost tracking**: `total_cost_usd` from `result` event. No regex parsing. Appended as footer on completion.
- **Thread = session**: one thread = one Claude Code session. Thread ID is the session key.
- **Streaming**: bot sends initial message, edits as output accumulates (~1.5s flush), ✅ reaction on completion.

## Implementation Invariants

Hard constraints across all phases:

- **Secret redaction before every Discord write.** Middleware wrapping all `message.send()` and `message.edit()`. Never rely on log-layer filtering.
- **Command allowlist before `spawn()`.** Validate `/run` input against `allowedShellCommands` before shell execution.
- **Path traversal prevention.** Canonicalize paths in `/file`, `/tree`, all file-touching commands. Reject anything outside project root.
- **Process watchdog.** Every spawned process gets `maxSessionDuration` enforcement. Clean up PTY and notify user on termination.

## Development Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Project setup: package.json, tsconfig, eslint, jest, CI, test Discord server | Not started |
| 1 | `/claude`, streaming, session management, RBAC | Not started |
| 2 | `/file`, `/tree`, `/diff`, `/git *`, secret redaction | Not started |
| 3 | `/run`, `/test`, `/build`, `/lint`, project switching | Not started |
| 4 | Mobile polish: buttons, image attachments, DM mode | Not started |
| 5 | `/watch`, `/schedule`, snippets, approval gates | Not started |

## Conventions

- **TypeScript strict mode** (`strict: true`), **ES modules** (`"type": "module"`)
- **Naming**: camelCase for variables/config, kebab-case for slash commands (`/claude-end`), PascalCase for classes/types
- **Logging**: pino with structured fields. Every invocation includes `user`, `timestamp`, `workingDirectory`.
- **Error handling**: degrade gracefully, never crash on unexpected input
- **Process**: follow `PROCESS.md` 10-stage pipeline. Front-load design.

## Security-Critical Code Paths

1. **Streaming buffer → Discord write**: secret redaction must run before every write
2. **`/run` input → shell execution**: allowlist enforced before spawning
3. **`/file`/`/tree` path → filesystem read**: prevent path traversal, jail to project root

## Testing

- Discord testing requires a **live bot token** and **dedicated test guild**
- Minimum coverage: streaming flow and approval gate flow
- `npx tsc --noEmit` and linting must pass cleanly

## Key References

| Document | Purpose |
|----------|---------|
| `PRD.md` | Full product spec |
| `DESIGN.md` | Design decisions, schemas, constraints, spike results |
| `PROCESS.md` | Development methodology and security review checklist |
