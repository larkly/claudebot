# PRD: Discord Claude Code Bot

## Overview

A Discord bot that acts as a remote interface to Claude Code, enabling developers to interact with their codebase from anywhere — including mobile. Each Discord thread maps to an isolated Claude Code session with full streaming output, file browsing, and project management capabilities.

The core insight: Discord is already on your phone, your tablet, and your desktop. By bridging it to Claude Code running on your dev machine (or a cloud VM), you get a portable, always-available coding assistant with real terminal access.

---

## Problem

When you're away from your workstation — commuting, in a meeting, on the couch — you lose the ability to interact with your code. You might want to:

- Ask Claude to investigate a bug you just remembered
- Kick off a refactor you've been thinking about
- Check the status of your project or review recent changes
- Read through a file you need context on
- Run a quick test or build to see if something passes
- Triage an alert or incident by inspecting code and logs

Today this requires opening a laptop, SSHing in, and launching Claude Code. A Discord bot eliminates that friction entirely.

---

## Goals

1. **Remote access** — interact with Claude Code from any device with Discord
1. **Real-time feedback** — stream Claude Code output as it works, not just the final result
1. **Session isolation** — each thread is an independent session; multiple people or tasks don't collide
1. **Safety** — sensible guardrails to prevent destructive operations without explicit approval
1. **Mobile-first UX** — design for small screens, slow typing, and intermittent connectivity

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Discord    │─ws─▶│   Bot Server     │─pty─▶│  Claude Code    │
│  (mobile /   │◀─ws─│   (Node.js)      │◀─────│  CLI Process    │
│   desktop)   │     │                  │      │                 │
└──────────────┘     │ - Session mgmt   │      │ - Your project  │
                     │ - Stream buffer  │      │ - File system   │
                     │ - Auth/perms     │      │ - Git, tests    │
                     └──────────────────┘      └─────────────────┘
```

The bot server runs on the same machine as your codebase (or a cloud VM with access to it). It spawns Claude Code as a child process per session, captures output via a pseudo-terminal, and streams it to Discord.

### Deployment options

- **Local machine** — bot runs alongside your dev environment. Simple, but requires your machine to be on.
- **Cloud VM / VPS** — bot runs on a persistent server with your repo cloned. Always available.
- **Docker container** — sandboxed environment with mounted project directory. Best for security.

---

## Core Features

### 1. Thread-Based Sessions

Every `/claude` invocation creates a Discord thread. That thread *is* the session.

- Messages in the thread are sent to Claude Code as prompts
- Claude Code's responses stream back into the thread
- Session state (working directory, conversation context) persists for the thread's lifetime
- Multiple threads can run in parallel for different tasks or projects

**Commands:**

| Command            | Description                                                                 |
|--------------------|-----------------------------------------------------------------------------|
| `/claude <prompt>` | Start a new session thread with an initial prompt                           |
| `/claude-end`      | Terminate the session and archive the thread                                |
| `/claude-status`   | Show session info: uptime, message count, working directory, running process|
| `/claude-sessions` | List all active sessions server-wide                                        |

### 2. Streaming Output

Claude Code can take 30 seconds to several minutes. Showing nothing until completion is a terrible experience, especially on mobile where you might think the app froze.

**Approach: progressive Discord message editing**

1. When Claude Code starts producing output, the bot sends an initial message
1. As new chunks arrive (via stdout streaming), the bot edits the message in place every ~1.5 seconds
1. If the message exceeds Discord's 2000-char limit, the bot finalizes the current message and starts a new one
1. A typing indicator is shown while Claude Code is actively running
1. The final message gets a ✅ reaction to signal completion

**Implementation notes:**

- Use a pseudo-terminal (node-pty) instead of raw `spawn` to capture Claude Code's rich output properly
- Buffer incoming chunks and flush on a 1–2 second interval to avoid Discord rate limits (5 edits per 5 seconds per message)
- Attach a "⏳ Working…" embed footer while in progress, replaced with "✅ Done" on completion

### 3. File Browser

Sometimes you just want to look at a file, not run Claude Code for it.

| Command               | Description                                             |
|-----------------------|---------------------------------------------------------|
| `/file <path>`        | Display a file's contents with syntax highlighting      |
| `/tree [path] [depth]`| Show directory structure                                |
| `/diff [file]`        | Show uncommitted changes (or changes to a specific file)|

**File display behavior:**

- Files under 2000 chars render inline in a code block with language detection
- Larger files are uploaded as a Discord attachment for download/preview
- Binary files show metadata only (size, type)
- The `/tree` command respects `.gitignore` by default

### 4. Git Integration

Quick git operations without needing a full Claude Code session.

| Command           | Description                                        |
|-------------------|----------------------------------------------------|
| `/git status`     | Show current branch, staged/unstaged changes       |
| `/git log [n]`    | Show last N commits (default 10) as a compact embed|
| `/git branch`     | List branches, highlight current                   |
| `/git diff [ref]` | Show diff against a ref, or uncommitted changes    |

Output is formatted as Discord embeds — color-coded, compact, and readable on mobile.

### 5. Quick Run

Run predefined or arbitrary shell commands without a full Claude Code session. Useful for builds, tests, and checks.

| Command          | Description                                    |
|------------------|------------------------------------------------|
| `/run <command>` | Execute a shell command and stream output      |
| `/test [filter]` | Run your test suite (configurable test command)|
| `/build`         | Run your build command                         |
| `/lint [file]`   | Run linter on a file or the whole project      |

These commands use the same streaming infrastructure as Claude Code sessions. Commands are configurable per-project via a `.discord-claude.json` config file:

```json
{
  "project": "my-app",
  "workingDir": "/home/user/projects/my-app",
  "commands": {
    "test": "npm test",
    "build": "npm run build",
    "lint": "npx eslint .",
    "typecheck": "npx tsc --noEmit"
  },
  "allowedShellCommands": ["npm", "npx", "node", "git", "cat", "ls", "grep"],
  "maxSessionDuration": 3600
}
```

### 6. Project Switching

If you work on multiple repos, you should be able to switch context.

| Command                      | Description                               |
|------------------------------|-------------------------------------------|
| `/project list`              | List configured projects                  |
| `/project switch <name>`     | Change the active project for new sessions|
| `/project add <name> <path>` | Register a new project directory          |

Each project is a named working directory. When you start a new `/claude` session, it runs in the active project's directory.

### 7. Notification & Watch Mode

Get proactive alerts without polling. Useful for long-running tasks or CI-like workflows.

| Command                      | Description                                                                 |
|------------------------------|-----------------------------------------------------------------------------|
| `/watch <command>`           | Run a command and get pinged when it finishes (e.g., `/watch npm run build`)|
| `/notify-on-fail <command>`  | Only get pinged if the command exits non-zero                               |
| `/schedule <cron> <command>` | Run a command on a schedule (e.g., run tests every hour)                   |

When a watched command completes, the bot sends a DM or channel ping with the exit code and a summary of the output. Perfect for kicking off a long build from your phone and getting notified when it's done.

### 8. Snippet Save & Replay

When Claude Code produces useful output (a code fix, a command sequence, an explanation), you should be able to bookmark it.

- React to any bot message with 📌 to save it as a named snippet
- `/snippets` lists saved snippets
- `/snippet <name>` retrieves one
- Snippets are stored per-project and persist across sessions

### 9. Approval Gates

Claude Code can make destructive changes. On mobile, you want a confirmation step before anything risky.

**Behavior:**

- When Claude Code attempts to write/delete files, the bot posts a summary of proposed changes as an embed
- The user reacts with ✅ to approve or ❌ to reject
- Configurable: `autoApprove: true` in project config to skip gates (for trusted environments)
- File deletions always require approval regardless of config

This mirrors Claude Code's own approval flow, surfaced through Discord's interaction model.

---

## Mobile UX Considerations

These features are specifically designed for the phone-in-hand experience:

**Quick-reply prompts.** After Claude Code responds, the bot can suggest 2–3 follow-up actions as Discord buttons: "Apply changes", "Show diff", "Run tests". This reduces typing on mobile.

**Voice-to-text friendly.** The bot should handle natural language gracefully. "Show me the main config file" should work as well as `/file src/config.ts`. Consider adding a natural language fallback in threads — if the message doesn't start with `/`, treat it as a Claude Code prompt.

**Compact embeds.** All structured output (git status, file trees, test results) uses Discord embeds tuned for narrow viewports. No wide tables, no horizontal scrolling. Prefer vertical layouts.

**DM mode.** Allow the bot to work in DMs for private, single-user use. Same thread model, but without the server context.

**Image/screenshot input.** Discord makes it easy to share photos from your phone. The bot should accept image attachments in threads and pass them to Claude Code's vision capabilities. Use case: photograph a whiteboard, error on a screen, or a design mockup and ask Claude to work with it.

---

## Permissions & Security

### Authentication

- **Role-based access.** Configure which Discord roles can use the bot. At minimum, separate "read" (view files, git status) from "write" (Claude Code sessions, shell commands).
- **Per-channel restriction.** Limit bot usage to specific channels to avoid noise.
- **Rate limiting.** Cap concurrent sessions per user and total API/process usage.

### Safety

- **Command allowlist.** The `/run` command only executes commands matching the `allowedShellCommands` config.
- **Working directory jail.** Claude Code and shell commands are chrooted to the project directory.
- **No secrets in chat.** The bot redacts environment variables, API keys, and tokens from output using pattern matching (configurable regex list).
- **Audit log.** All commands and Claude Code invocations are logged with user, timestamp, and working directory.

---

## Configuration

All config lives in `~/.discord-claude/config.json` or a `.discord-claude.json` in the project root (project-level overrides global).

```json
{
  "global": {
    "allowedRoles": ["developer", "admin"],
    "maxConcurrentSessions": 5,
    "maxSessionDuration": 3600,
    "secretPatterns": [
      "sk-[a-zA-Z0-9]+",
      "ghp_[a-zA-Z0-9]+",
      "AKIA[A-Z0-9]+"
    ]
  },
  "projects": {
    "my-app": {
      "path": "/home/user/projects/my-app",
      "commands": {
        "test": "npm test",
        "build": "npm run build",
        "lint": "npx eslint ."
      },
      "autoApprove": false,
      "allowedShellCommands": ["npm", "npx", "node", "git", "cat", "ls"]
    }
  }
}
```

---

## Tech Stack

| Component          | Choice        | Rationale                                                          |
|--------------------|---------------|--------------------------------------------------------------------|
| Runtime            | Node.js 20+   | Native Discord.js support, good process management                 |
| Discord library    | discord.js v14| Most mature, best TypeScript support                               |
| Process management | node-pty      | Pseudo-terminal for proper Claude Code output capture and streaming|
| Configuration      | cosmiconfig   | Supports JSON, YAML, and JS config files with hierarchical merging |
| Logging            | pino          | Fast structured logging for audit trail                            |
| Process supervisor | pm2 or systemd| Keep the bot alive across restarts                                 |

---

## Milestones

### Phase 1: Core Loop

- Thread-based sessions with `/claude`
- Streaming output via message editing
- Basic session management (`/claude-end`, `/claude-status`)
- Role-based access control

### Phase 2: File & Git

- `/file`, `/tree`, `/diff` commands
- `/git status`, `/git log`, `/git branch`
- Secret redaction

### Phase 3: Run & Build

- `/run`, `/test`, `/build`, `/lint` commands
- Project config file support
- `/project list` and `/project switch`

### Phase 4: Mobile Polish

- Button-based follow-up suggestions
- Image attachment support in threads
- DM mode
- Compact embed formatting pass

### Phase 5: Automation

- `/watch` and `/notify-on-fail`
- `/schedule` for cron-like execution
- Snippet save and replay
- Approval gates for destructive operations

---

## Open Questions

1. **Conversation continuity.** Each `claude -p` call is stateless. Options: (a) prepend conversation history to each prompt, (b) use Claude Code's `--resume` flag if supported, (c) accept statelessness and let the user provide context. Need to test which gives the best experience within Claude Code's context limits.
1. **Multi-user collaboration.** If two people post in the same thread, should both messages go to Claude Code? Current design says yes. May need a "lock" mechanism so one person can claim a session.
1. **Cost management.** Each Claude Code invocation uses API credits. Should the bot surface token usage per session? Should there be per-user daily limits?
1. **Persistent sessions.** If the bot restarts, all sessions are lost. Options: persist session metadata to disk, or accept that sessions are ephemeral and users re-create threads as needed.
1. **Self-hosting vs. hosted.** This is designed for self-hosting. Is there demand for a hosted version where users connect their own API key and repo via OAuth?
