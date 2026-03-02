# Design Document

Detailed design decisions, schemas, and constraints for the Discord Claude Code Bot. For a concise overview, see `CLAUDE.md`.

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

## Session State Schema

```typescript
interface SessionState {
  threadId: string;              // Discord thread ID (primary key)
  ownerId: string;               // Discord user ID of session owner
  projectName: string;           // Active project for this session
  claudeSessionId: string | null; // Claude Code session ID for --resume; null until first result event
  ptyProcess: IPty | null;       // node-pty handle for current invocation; null when idle between messages
  startedAt: number;             // Date.now() timestamp
  lastActivityAt: number;        // Date.now() of last owner message (for idle timeout)
  watchdogTimer: NodeJS.Timeout; // maxSessionDuration enforcement
  idleTimer: NodeJS.Timeout;     // idleTimeoutSeconds enforcement
  currentMessageId: string;      // ID of the message being edited for streaming
  outputBuffer: string;          // Pending output not yet flushed to Discord
}
```

**Execution model:** `ptyProcess` is per-invocation, not per-session. Each user message spawns a new `claude` process (with `--resume` after the first) that exits after producing its response. `ptyProcess` is set when a process starts and reset to `null` when it exits. `claudeSessionId` is set from the first invocation's `result` event and reused for all subsequent invocations in the same thread. The session record persists in the Map for the lifetime of the thread's active session, but `ptyProcess` inside it is transient.

## Design Decision Record (updated 2026-03-01)

### Decision 1: Conversation Continuity

FINAL: `--resume` mode (spike completed 2026-03-01, confirmed working)

BASIS: Manual spike confirmed that `claude --resume <session_id> -p "<prompt>" --output-format stream-json` preserves full conversation context across process exits. Session IDs are stable. Context is loaded via prompt cache (`cache_read_input_tokens`), making resumed calls fast and cheap. Original stateless decision upgraded per the revisit condition.

SPIKE RESULTS:
- `claude -p "<prompt>" --output-format json` returns `session_id` in the result event
- `claude --resume <session_id> -p "<prompt>"` correctly recalls prior conversation context
- `--output-format stream-json` emits structured events: `system` (init), `assistant` (content), `result` (final)
- `cwd` is anchored to the directory of the first invocation — subsequent `--resume` calls inherit it
- Session IDs survive process exit and work across multiple sequential invocations

CONSTRAINT FOR AGENTS:
- First invocation in a thread: `claude -p "<prompt>" --output-format stream-json` with `cwd` set to the configured project path
- Parse `session_id` from the `result` event and store in `SessionState.claudeSessionId`
- Subsequent invocations: `claude --resume <session_id> -p "<prompt>" --output-format stream-json`
- `cwd` only matters on the first spawn — `--resume` inherits the original working directory
- If `--resume` fails (e.g., expired or corrupted session), fall back to a fresh `claude -p` invocation and store the new `session_id`
- Stateless mode (`claude -p` without `--resume`) remains available as a fallback

STREAM-JSON EVENT SCHEMA:
```jsonc
// Event 1: session init (first event emitted)
{"type": "system", "subtype": "init", "session_id": "...", "cwd": "/path/to/project", ...}

// Event 2+: assistant response content (one or more)
{"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}], ...}, "session_id": "..."}

// Final event: result with cost data
{"type": "result", "subtype": "success", "result": "...", "session_id": "...", "total_cost_usd": 0.05, "usage": {...}}
```

### Decision 2: Multi-User Sessions

FINAL: lock-in-memory with clear messaging

BASIS: discord-expert (lock-in-memory) and ux-expert (lock-with-clear-messaging) both agreed; llm-expert abstained. Two of three agree.

CONSTRAINT FOR AGENTS: Maintain session state in a `Map<string, SessionState>` keyed by thread ID. When a non-owner posts in a locked thread, reply with a **regular (non-ephemeral) thread message** — ephemeral is not available on `messageCreate` events, only on interaction replies. Lock message text: `"This session belongs to @[owner] (active [N]m ago). Start your own: \`/claude <prompt>\` in any channel."` Only the session owner or a user with an admin-configured role may run `/claude-end`. Two independent timers per session: `idleTimeoutSeconds` (default 600 — releases lock on owner inactivity) and `maxSessionDuration` (default 3600 — kills the process regardless of activity). When idle timeout fires, post a single message in the thread: `"@[owner] Session released due to inactivity. Thread is now available — use \`/claude\` to start a new session here, or start a fresh thread."` (The @mention is embedded in the message body; no separate notification needed.)

REVISIT CONDITION: If a queue-based model is needed (high-traffic multi-user server), add a FIFO queue per thread in Phase 4.

### Decision 3: Cost Management

DECISION: decided — session cost footer in Phase 1; per-user daily limits deferred to Phase 3

CONSTRAINT FOR AGENTS (Phase 1): With `--output-format stream-json`, cost data is available directly in the `result` event as `total_cost_usd` (number, USD). No regex parsing needed — read the field from the parsed JSON. Append cost to the session completion message as a footer (e.g., `"Cost: $0.05"`). Log a warning if the `result` event has no `total_cost_usd` field.

CONSTRAINT FOR AGENTS (Phase 3): Add `maxDailyCostPerUser` (number, USD) to the global config. Track per-user daily spend in `~/.discord-claude/usage.json` (reset at midnight). Block new sessions when the limit is reached.

### Decision 4: Natural Language Fallback

DECISION: decided — treat plain thread messages as prompts (thread-mode)

CONSTRAINT FOR AGENTS: In the `messageCreate` handler, apply these checks in order: (1) `message.channel.isThread()`, (2) active session exists for `message.channel.id`, (3) `message.author.id === session.ownerId`, (4) `!message.author.bot`. If all pass, spawn `claude --resume <session.claudeSessionId> -p "<message.content>" --output-format stream-json` (using the stored session ID for context continuity), reset the idle timer, and stream output into the thread. If (1)–(2) pass but (3) fails (non-owner), send the lock message. If (1) passes but (2) fails (no active session), reply: `"No active session in this thread. Use \`/claude <prompt>\` to start a new one."` Do NOT create a session from a plain message — sessions are only created via `/claude`. For messages under 10 characters, prepend `"⚠️ Short prompt forwarded to Claude."` to the bot's acknowledgment (do not block).

NOTE: `GatewayIntentBits.MessageContent` is a privileged intent. Enable in the Discord Developer Portal AND in the client constructor. This is a Phase 0 requirement.

### Decision 5: Persistent Sessions

DECISION: decided — ephemeral sessions with restart notifications

CONSTRAINT FOR AGENTS: Do NOT persist PTY processes. On session start, write the thread ID, owner ID, and `claudeSessionId` to `~/.discord-claude/active-threads.json`. Update `claudeSessionId` in the file after each invocation's `result` event. On session end (normal, crashed, or timed out), remove the entry. On bot startup, read `active-threads.json` and attempt to resume each session — the stored `claudeSessionId` allows `--resume` to restore conversation context even after a bot restart. If `--resume` fails, post the restart message below and start fresh. This disk write is required in Phase 1, not optional.

RESTART MESSAGE (used only when `--resume` fails after restart): `"This session was interrupted by a bot restart and the previous context could not be restored. To continue working, start a new session with \`/claude <prompt>\`. Sorry for the interruption."`

RESTART RESUME MESSAGE (used when `--resume` succeeds after restart): `"Bot restarted, but your session context has been restored. You can continue where you left off."`

### Cross-Cutting Issues

- **`--resume` spike** — RESOLVED (2026-03-01): Confirmed working. `--resume` preserves context across process exits. `--output-format stream-json` provides structured events including `session_id` and `total_cost_usd`. `cwd` is anchored to the first invocation's working directory — must be set to the configured project path on first spawn. See Decision 1 for full results.
- **`MessageContent` privileged intent** — RESOLVED (Phase 0): Enable in Discord Developer Portal and in `Client({ intents: [GatewayIntentBits.MessageContent, ...] })`. Without it, `message.content` is empty.
- **Two independent timers per session** — RESOLVED: `idleTimeoutSeconds` releases the lock on owner inactivity; `maxSessionDuration` kills the process. Both configurable independently. Added to config shape above.
- **Restart notification requires disk write** — RESOLVED (Phase 1 scope): Write active thread IDs to `~/.discord-claude/active-threads.json`. Required in Phase 1.
- **Bot required permissions** — RESOLVED (Phase 0): `SendMessages`, `SendMessagesInThreads`, `CreatePublicThreads`, `CreatePrivateThreads`, `ManageThreads`, `AddReactions`, `ReadMessageHistory`, `EmbedLinks`. Encode in OAuth2 invite URL scopes.
- **Thread creation from `/claude`** — RESOLVED: Initial reply must be a regular (non-ephemeral) message. Create the thread from that message. Thread type (public/private) is configurable; default to public.
- **Cost data from CLI output** — RESOLVED: With `--output-format stream-json`, cost is available as `total_cost_usd` in the `result` event. No regex parsing needed. `costPattern` config key is no longer necessary.
- **Solo developer returning to a dead thread** — RESOLVED: Covered by Natural Language Fallback handler — if no active session exists, bot replies with the "No active session" message.
