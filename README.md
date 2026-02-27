# claudebot

A Discord bot that bridges Discord threads to Claude Code CLI sessions. Developers can interact with their codebase from any device — including mobile — without opening a terminal.

See `PRD.md` for the full product specification.

---

## What It Is

claudebot runs on the same machine as your codebase (or a cloud VM with access to it). It listens for slash commands in Discord, spawns Claude Code as a subprocess per session, and streams output back into the thread in real time.

The core model: one Discord thread equals one Claude Code session. Send a message in the thread, Claude Code processes it, the bot streams the response back. Multiple threads run in parallel for different tasks or projects.

## Why It Exists

When you are away from your workstation, interacting with your code requires opening a laptop, SSHing in, and launching Claude Code. claudebot eliminates that friction by making Discord — which is already on your phone, tablet, and desktop — a first-class interface to your development environment.

---

## Architecture

```
┌──────────────┐     ┌──────────────────────────────┐     ┌─────────────────┐
│   Discord    │─ws─▶│          Bot Server           │─pty─▶│  Claude Code    │
│  (mobile /   │◀─ws─│          (Node.js)            │◀────│  CLI Process    │
│   desktop)   │     │                               │     │                 │
└──────────────┘     │  ┌────────────────────────┐  │     │ - Your project  │
                     │  │     Discord Layer       │  │     │ - File system   │
                     │  │  slash commands, embeds │  │     │ - Git, tests    │
                     │  └───────────┬────────────┘  │     └─────────────────┘
                     │              │                │
                     │  ┌───────────▼────────────┐  │
                     │  │    Session Manager      │  │
                     │  │  thread ID → process   │  │
                     │  └───────────┬────────────┘  │
                     │              │                │
                     │  ┌───────────▼────────────┐  │
                     │  │    Process Layer        │  │
                     │  │  node-pty, stream buf   │  │
                     │  └────────────────────────┘  │
                     └──────────────────────────────┘
```

**Three layers:**

1. **Discord layer** — receives slash commands and thread messages, sends and edits messages and embeds. Each `/claude <prompt>` call creates a new Discord thread that owns one session.

2. **Session manager** — maps Discord thread IDs to running Claude Code processes. Handles lifecycle (spawn, stream, terminate) and enforces `maxConcurrentSessions` and `maxSessionDuration`.

3. **Process layer** — spawns `claude` CLI via node-pty so that Claude Code's terminal output is captured correctly. Buffers stdout chunks and flushes to Discord on a ~1.5 s interval to stay within Discord's rate limit (5 edits per 5 s per message). When a message hits the Discord 2000-char limit, the current message is finalized and a new one is started.

---

## Tech Stack

| Component          | Choice         |
|--------------------|----------------|
| Runtime            | Node.js 20+ with TypeScript |
| Discord library    | discord.js v14 |
| Process management | node-pty       |
| Configuration      | cosmiconfig    |
| Logging            | pino           |
| Process supervisor | pm2 or systemd |

---

## Installation

> Note: no code exists yet. These steps reflect the intended setup once Phase 1 is implemented.

**Prerequisites**

- Node.js 20+
- Claude Code CLI installed and authenticated (`claude` available in PATH)
- A Discord application and bot token with the Message Content and Server Members intents enabled

**Steps**

```sh
# 1. Clone the repository
git clone https://github.com/your-org/claudebot.git
cd claudebot

# 2. Install dependencies
npm install

# 3. Set the bot token
export DISCORD_BOT_TOKEN=your-token-here

# 4. Create a config file (see Configuration section)
mkdir -p ~/.discord-claude
cp config.example.json ~/.discord-claude/config.json

# 5. Start the bot
npm start
```

To keep the bot running across restarts:

```sh
pm2 start dist/index.js --name claudebot
pm2 save
```

---

## Configuration

Config is loaded from `~/.discord-claude/config.json` (global) merged with `.discord-claude.json` in the project root (project-level overrides global).

```jsonc
// ~/.discord-claude/config.json
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
        "lint": "npx eslint .",
        "typecheck": "npx tsc --noEmit"
      },
      "autoApprove": false,
      "allowedShellCommands": ["npm", "npx", "node", "git", "cat", "ls", "grep"]
    }
  }
}
```

**Key fields:**

- `allowedRoles` — Discord roles permitted to use the bot.
- `maxConcurrentSessions` — cap on simultaneous Claude Code processes.
- `maxSessionDuration` — seconds before a session is forcibly terminated.
- `secretPatterns` — regex list; matches are redacted from all output before it reaches Discord.
- `allowedShellCommands` — allowlist for `/run`; commands not in this list are rejected.
- `autoApprove` — when `false`, destructive file operations require Discord reaction approval. File deletions always require approval regardless of this setting.

---

## Commands

### Session management

| Command              | Description                                                    |
|----------------------|----------------------------------------------------------------|
| `/claude <prompt>`   | Start a new session thread with an initial prompt             |
| `/claude-end`        | Terminate the session and archive the thread                  |
| `/claude-status`     | Show session info: uptime, message count, working directory   |
| `/claude-sessions`   | List all active sessions server-wide                          |

### File and diff

| Command                 | Description                                             |
|-------------------------|---------------------------------------------------------|
| `/file <path>`          | Display a file's contents with syntax highlighting     |
| `/tree [path] [depth]`  | Show directory structure (respects .gitignore)         |
| `/diff [file]`          | Show uncommitted changes, or changes to a specific file|

### Git

| Command            | Description                                      |
|--------------------|--------------------------------------------------|
| `/git status`      | Show current branch, staged and unstaged changes |
| `/git log [n]`     | Show last N commits as a compact embed           |
| `/git branch`      | List branches, highlight current                 |
| `/git diff [ref]`  | Show diff against a ref or uncommitted changes   |

### Run and build

| Command           | Description                                      |
|-------------------|--------------------------------------------------|
| `/run <command>`  | Execute a shell command and stream output        |
| `/test [filter]`  | Run the configured test suite                    |
| `/build`          | Run the configured build command                 |
| `/lint [file]`    | Run linter on a file or the whole project        |

### Project management

| Command                       | Description                                  |
|-------------------------------|----------------------------------------------|
| `/project list`               | List configured projects                     |
| `/project switch <name>`      | Change the active project for new sessions   |
| `/project add <name> <path>`  | Register a new project directory             |

### Watch and schedule

| Command                       | Description                                              |
|-------------------------------|----------------------------------------------------------|
| `/watch <command>`            | Run a command and get notified when it finishes          |
| `/notify-on-fail <command>`   | Notify only on non-zero exit                             |
| `/schedule <cron> <command>`  | Run a command on a cron schedule                         |

### Snippets

| Command            | Description                          |
|--------------------|--------------------------------------|
| `/snippets`        | List saved snippets                  |
| `/snippet <name>`  | Retrieve a snippet by name           |

React to any bot message with a pin reaction to save it as a snippet.

---

## Roadmap

| Phase | Scope                                                                  | Status  |
|-------|------------------------------------------------------------------------|---------|
| 1     | `/claude`, streaming output, session management, RBAC                  | Planned |
| 2     | `/file`, `/tree`, `/diff`, `/git *`, secret redaction                  | Planned |
| 3     | `/run`, `/test`, `/build`, `/lint`, project switching                  | Planned |
| 4     | Mobile polish: buttons, image attachments, DM mode, compact embeds     | Planned |
| 5     | `/watch`, `/schedule`, snippet save and replay, approval gates         | Planned |

---

## Security

- **Secret redaction** — all output is filtered through `secretPatterns` before being sent to Discord. This runs before every Discord write, not after.
- **Command allowlist** — `/run` enforces `allowedShellCommands` before shell execution.
- **Working directory jail** — Claude Code and shell commands are scoped to the configured project path.
- **Approval gates** — destructive file operations post a Discord embed for explicit user confirmation before proceeding.
- **Audit log** — all commands and Claude Code invocations are logged via pino with user, timestamp, and working directory.

---

## Development

This project follows the pipeline described in `PROCESS.md`: design first, build second. Before implementing anything, read the relevant stage definitions there.

**Dev setup (once Phase 1 code exists):**

```sh
npm install
npm run build        # compile TypeScript
npm run typecheck    # npx tsc --noEmit
npm run lint         # eslint
npm test             # test suite
```

All pull requests must pass typecheck, lint, and tests. The audit log must emit correct pino entries for all commands and Claude Code invocations — this is the primary visibility window for a self-hosted deployment.

**Contributing:**

1. Read `PRD.md` to understand the full spec before starting work.
2. Read `PROCESS.md` for the expected development pipeline.
3. Open a brief issue or discussion before building anything non-trivial.
4. Each PR should map to an atomic unit from the planning stage.

---

## Deployment Options

- **Local machine** — bot runs alongside your dev environment. Simple, but requires the machine to be on.
- **Cloud VM / VPS** — bot runs on a persistent server with your repo cloned. Always available.
- **Docker container** — sandboxed environment with a mounted project directory.
