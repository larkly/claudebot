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
CONSTRAINT FOR AGENTS: Maintain session state in a `Map<string, SessionState>` keyed by thread ID. When a non-owner posts in a locked thread, reply with a **regular (non-ephemeral) thread message** — ephemeral is not available on `messageCreate` events, only on interaction replies. Lock message text: `"This session belongs to @[owner] (active [N]m ago). Start your own: \`/claude <prompt>\` in any channel."` Only the session owner or a user with an admin-configured role may run `/claude-end`. Two independent timers per session: `idleTimeoutSeconds` (default 600 — releases lock on owner inactivity) and `maxSessionDuration` (default 3600 — kills the process regardless of activity). When idle timeout fires, post in the thread: `"@[owner] session released due to inactivity. Thread is now available — use \`/claude\` to start a new session here, or start a fresh thread."` then `@mention` the owner.

LOCK STATE SCHEMA:
```typescript
interface SessionState {
  threadId: string;              // Discord thread ID (primary key)
  ownerId: string;               // Discord user ID of session owner
  projectName: string;           // Active project for this session
  ptyProcess: IPty;              // node-pty process handle
  startedAt: number;             // Date.now() timestamp
  lastActivityAt: number;        // Date.now() of last owner message (for idle timeout)
  watchdogTimer: NodeJS.Timeout; // maxSessionDuration enforcement
  idleTimer: NodeJS.Timeout;     // idleTimeoutSeconds enforcement
  currentMessageId: string;      // ID of the message being edited for streaming
  outputBuffer: string;          // Pending output not yet flushed to Discord
}
```

REVISIT CONDITION: If a queue-based model is needed (high-traffic multi-user server), add a FIFO queue per thread in Phase 4.

### Open: Cost Management

DECISION: decided — session cost footer in Phase 1; per-user daily limits deferred to Phase 3
CONSTRAINT FOR AGENTS (Phase 1): Parse Claude Code CLI stdout for cost/token summary on the final 10 lines of output (regex: `/\$[\d.]+|\d+ tokens?/i`). Append to the session completion message as a footer. Make the regex configurable in global config. Log a warning if no cost data is found in a completed session's output.
CONSTRAINT FOR AGENTS (Phase 3): Add `maxDailyCostPerUser` (number, USD) to the global config. Track per-user daily spend in `~/.discord-claude/usage.json` (reset at midnight). Block new sessions when the limit is reached.

### Open: Natural Language Fallback

DECISION: decided — treat plain thread messages as prompts (thread-mode)
CONSTRAINT FOR AGENTS: In the `messageCreate` handler, apply these checks in order: (1) `message.channel.isThread()`, (2) active session exists for `message.channel.id`, (3) `message.author.id === session.ownerId`, (4) `!message.author.bot`. If all pass, write `message.content + '\n'` to the PTY and reset the idle timer. If (1)–(2) pass but (3) fails (non-owner), send the lock message. If (1) passes but (2) fails (no active session), reply: `"No active session in this thread. Use \`/claude <prompt>\` to start a new one."` Do NOT create a session from a plain message. For messages under 10 characters, prepend `"⚠️ Short prompt forwarded to Claude."` to the bot's acknowledgment (do not block).
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

## Development phases (from PRD)

| Phase | Scope |
|-------|-------|
| 0 | Project setup: package.json, tsconfig, eslint, jest, CI, test Discord server |
| 1 | `/claude`, streaming, session management, RBAC |
| 2 | `/file`, `/tree`, `/diff`, `/git *`, secret redaction |
| 3 | `/run`, `/test`, `/build`, `/lint`, project switching |
| 4 | Mobile polish: buttons, image attachments, DM mode |
| 5 | `/watch`, `/schedule`, snippets, approval gates |
