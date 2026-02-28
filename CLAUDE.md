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
    "idleTimeoutSeconds": 600,
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

## Design decisions

These have been explicitly decided and should not be relitigated without good reason:

- **Conversation continuity**: stateless for Phase 1 MVP. Use `claude -p "<prompt>"` for all invocations. No history prepending. `--resume` evaluated via spike at start of Phase 1.
- **Multi-user sessions**: session lock. The first user to post in a thread owns that session. Other users receive a regular thread message explaining the lock and how to start their own session.
- **Natural language fallback**: plain messages in active session threads are forwarded to Claude Code as prompts. Sessions are only *created* via `/claude`.
- **Persistent sessions**: ephemeral. Active thread IDs are written to disk for restart notification; no PTY or session state is persisted.

## Design Decision Record (updated 2026-02-28)

### Decision 1: Conversation Continuity

FINAL: stateless for Phase 1 MVP
BASIS: llm-expert recommended `--resume`; ux-expert recommended `stateless-with-template`; discord-expert abstained. One vs. one; per synthesis rule (minimize Phase 1 scope, keep reversible), stateless wins. `--resume` is a mandatory spike at the start of Phase 1.
CONSTRAINT FOR AGENTS: Use `claude -p "<prompt>"` for all Phase 1 invocations. Do NOT prepend thread history. Do NOT implement `--resume` without a prior spike confirming it works via node-pty (spawn `claude --resume <session-id>` via node-pty, send two prompts, verify second has context from first).
REVISIT CONDITION: If the Phase 1 spike confirms `claude --resume` works reliably via node-pty and session IDs are stable across process restarts, upgrade to `--resume` as the default (store `claudeSessionId` in `SessionState`) with stateless as fallback. If the spike fails, remain stateless for all phases.

### Decision 2: Multi-User Sessions

FINAL: lock-in-memory with clear messaging
BASIS: discord-expert (lock-in-memory) and ux-expert (lock-with-clear-messaging) both agreed; llm-expert abstained. Two of three agree.
CONSTRAINT FOR AGENTS: Maintain session state in a `Map<string, SessionState>` keyed by thread ID. When a non-owner posts in a locked thread, reply with a **regular (non-ephemeral) thread message** — ephemeral is not available on `messageCreate` events, only on interaction replies. Lock message text: `"This session belongs to @[owner] (active [N]m ago). Start your own: \`/claude <prompt>\` in any channel."` Only the session owner or a user with an admin-configured role may run `/claude-end`. Two independent timers per session: `idleTimeoutSeconds` (default 600 — releases lock on owner inactivity) and `maxSessionDuration` (default 3600 — kills the process regardless of activity). When idle timeout fires, post a single message in the thread: `"@[owner] Session released due to inactivity. Thread is now available — use \`/claude\` to start a new session here, or start a fresh thread."` (The @mention is embedded in the message body; no separate notification needed.)

LOCK STATE SCHEMA:
```typescript
interface SessionState {
  threadId: string;              // Discord thread ID (primary key)
  ownerId: string;               // Discord user ID of session owner
  projectName: string;           // Active project for this session
  ptyProcess: IPty | null;       // node-pty handle for current invocation; null when idle between messages
  startedAt: number;             // Date.now() timestamp
  lastActivityAt: number;        // Date.now() of last owner message (for idle timeout)
  watchdogTimer: NodeJS.Timeout; // maxSessionDuration enforcement
  idleTimer: NodeJS.Timeout;     // idleTimeoutSeconds enforcement
  currentMessageId: string;      // ID of the message being edited for streaming
  outputBuffer: string;          // Pending output not yet flushed to Discord
}
```
NOTE ON EXECUTION MODEL: `ptyProcess` is per-invocation, not per-session. In Phase 1 (stateless mode), each user message spawns a new `claude -p` process that exits after producing its response. `ptyProcess` is set when a process starts and reset to `null` when it exits. The session record (`SessionState`) persists in the Map for the lifetime of the thread's active session, but `ptyProcess` inside it is transient.

REVISIT CONDITION: If a queue-based model is needed (high-traffic multi-user server), add a FIFO queue per thread in Phase 4.

### Open: Cost Management

DECISION: decided — session cost footer in Phase 1; per-user daily limits deferred to Phase 3
CONSTRAINT FOR AGENTS (Phase 1): Parse Claude Code CLI stdout for cost/token summary on the final 10 lines of output. Match against the configured `costPattern` string (treated as a case-insensitive regex at runtime: `new RegExp(config.global.costPattern, 'i')`; default value: `"\\$[\\d.]+|\\d+ tokens?"`). Append the matched text to the session completion message as a footer. Log a warning if no match is found in a completed session's output.
CONSTRAINT FOR AGENTS (Phase 3): Add `maxDailyCostPerUser` (number, USD) to the global config. Track per-user daily spend in `~/.discord-claude/usage.json` (reset at midnight). Block new sessions when the limit is reached.

### Open: Natural Language Fallback

DECISION: decided — treat plain thread messages as prompts (thread-mode)
CONSTRAINT FOR AGENTS: In the `messageCreate` handler, apply these checks in order: (1) `message.channel.isThread()`, (2) active session exists for `message.channel.id`, (3) `message.author.id === session.ownerId`, (4) `!message.author.bot`. If all pass, spawn a new `claude -p "<message.content>"` process (same as the initial `/claude` handler), reset the idle timer, and stream output into the thread. If (1)–(2) pass but (3) fails (non-owner), send the lock message. If (1) passes but (2) fails (no active session), reply: `"No active session in this thread. Use \`/claude <prompt>\` to start a new one."` Do NOT create a session from a plain message — sessions are only created via `/claude`. For messages under 10 characters, prepend `"⚠️ Short prompt forwarded to Claude."` to the bot's acknowledgment (do not block).
NOTE: `GatewayIntentBits.MessageContent` is a privileged intent. Enable in the Discord Developer Portal AND in the client constructor. This is a Phase 0 requirement.

### Open: Persistent Sessions

DECISION: decided — ephemeral sessions with restart notifications
CONSTRAINT FOR AGENTS: Do NOT persist PTY processes or Claude Code session state to disk. On session start, write the thread ID and owner ID to `~/.discord-claude/active-threads.json`. On session end (normal, crashed, or timed out), remove the entry. On bot startup, read `active-threads.json` and post in each listed thread the restart message below, then clear the file. This disk write is required in Phase 1, not optional.
RESTART MESSAGE TEMPLATE: `"This session was interrupted by a bot restart. Your previous Claude Code process has ended. To continue working, start a new session with \`/claude <prompt>\` — you'll need to re-provide any relevant context. Sorry for the interruption."`
REVISIT CONDITION: If the Decision 1 `--resume` spike confirms that Claude Code session IDs survive process restarts, evaluate persisting `claudeSessionId` in `active-threads.json` to enable partial session resume.

### Cross-Cutting Issues

- **`--resume` spike** — DEFERRED: required at the start of Phase 1 before committing to stateless vs. resume architecture. See Decision 1 revisit condition. This is the single highest-priority technical unknown.
- **`MessageContent` privileged intent** — RESOLVED (Phase 0): Enable in Discord Developer Portal and in `Client({ intents: [GatewayIntentBits.MessageContent, ...] })`. Without it, `message.content` is empty.
- **Two independent timers per session** — RESOLVED: `idleTimeoutSeconds` releases the lock on owner inactivity; `maxSessionDuration` kills the process. Both configurable independently. Added to config shape above.
- **Restart notification requires disk write** — RESOLVED (Phase 1 scope): Write active thread IDs to `~/.discord-claude/active-threads.json`. Required in Phase 1.
- **Bot required permissions** — RESOLVED (Phase 0): `SendMessages`, `SendMessagesInThreads`, `CreatePublicThreads`, `CreatePrivateThreads`, `ManageThreads`, `AddReactions`, `ReadMessageHistory`, `EmbedLinks`. Encode in OAuth2 invite URL scopes.
- **Thread creation from `/claude`** — RESOLVED: Initial reply must be a regular (non-ephemeral) message. Create the thread from that message. Thread type (public/private) is configurable; default to public.
- **Cost regex coupling to CLI output format** — DEFERRED: Make the parsing regex configurable in global config (`costPattern`). Log a warning when no cost data is detected. Revisit if Anthropic changes CLI output format.
- **Solo developer returning to a dead thread** — RESOLVED: Covered by Natural Language Fallback handler — if no active session exists, bot replies with the "No active session" message.

## Implementation invariants

These must hold across all phases — treat them as hard constraints, not guidelines:

- **Secret redaction runs before every Discord write.** Implement as middleware wrapping all `message.send()` and `message.edit()` calls. Never rely on log-layer filtering.
- **Command allowlist enforced before `spawn()`.** Validate `/run` input against `allowedShellCommands` before any shell execution, not after.
- **Path traversal prevention.** Canonicalize and validate paths in `/file`, `/tree`, and all file-touching commands. Reject anything resolving outside the configured project root.
- **Process watchdog.** Every spawned Claude Code process must have a watchdog that enforces `maxSessionDuration` and handles hangs. Clean up PTY and notify user on termination.

## Development phases

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Project setup: package.json, tsconfig, eslint, jest, CI, test Discord server | Not started |
| 1 | `/claude`, streaming, session management, RBAC | Not started |
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
