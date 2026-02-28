# claudebot

A Discord bot that gives you remote access to Claude Code CLI sessions from any device, including your phone.

## How It Works

claudebot runs on the same machine as your codebase. When you type `/claude <prompt>` in Discord, the bot creates a thread, spawns a Claude Code CLI process, and streams its output back into that thread in real time by editing messages as new chunks arrive. One thread equals one session. The session is locked to the user who started it. Plain messages in the thread are forwarded to Claude Code as follow-up prompts; slash commands handle everything else.

```
You (phone/desktop)
  │
  ▼
Discord thread ──ws──▶ claudebot (Node.js) ──pty──▶ claude CLI
                ◀──ws──                     ◀──────  (your repo)
```

## Prerequisites

1. **Node.js 20+** installed on the host machine

2. **Native build tools** — required by node-pty (a C++ addon used to spawn Claude Code in a pseudo-terminal):
   - **macOS:** `xcode-select --install`
   - **Linux (Debian/Ubuntu):** `sudo apt install build-essential python3`
   - **Windows:** Use WSL, or install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with the C++ workload

3. **Claude Code CLI** installed, on PATH, and authenticated:
   ```sh
   npm install -g @anthropic-ai/claude-code
   claude auth   # run once interactively to store credentials
   claude --version  # verify it works
   ```
   The bot does not handle authentication — `claude` must be authenticated under the same user account that runs the bot process.

4. **Discord bot token** with privileged intents enabled:
   - Go to the [Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot**
   - Under **Privileged Gateway Intents**, enable **Server Members Intent** and **Message Content Intent**
   - Copy the bot token

5. **A git repository** the bot will operate on

## Quick Start

```sh
# 1. Create a Discord application and bot (if you haven't already)
#    See Prerequisites step 4 above for the Developer Portal setup steps.

# 2. Clone
git clone https://github.com/larkly/claudebot.git
cd claudebot

# 3. Install dependencies
npm install

# 4. Create config
#    "developer" below must match an actual role name in your Discord server.
#    Users without this role will be silently denied.
mkdir -p ~/.discord-claude
cat > ~/.discord-claude/config.json << 'EOF'
{
  "global": {
    "allowedRoles": ["developer"],
    "maxConcurrentSessions": 3,
    "maxSessionDuration": 3600
  },
  "projects": {
    "my-project": {
      "path": "/absolute/path/to/your/repo",
      "allowedShellCommands": ["npm", "npx", "node", "git"]
    }
  }
}
EOF

# 5. Set bot token
export DISCORD_BOT_TOKEN=your-token-here

# 6. Start the bot
npm start

# 7. Invite bot to your server
#    In the Developer Portal: OAuth2 → URL Generator
#    Scopes: bot, applications.commands
#    Permissions integer: 395137075264
#    (Send Messages, Send Messages in Threads, Create Public/Private Threads,
#     Manage Threads, Add Reactions, Read Message History, Embed Links)
#    Open the generated URL, select your server, click Authorize

# 8. In any channel, run:
#    /claude Explain the project structure
```

## Usage

### Starting a session with `/claude <prompt>`

Type `/claude <prompt>` in any channel. The bot replies, creates a thread from that message, and starts streaming Claude Code's output. Output is updated every ~1.5 seconds via message editing. When a message hits Discord's 2000-character limit, the bot finalizes it and starts a new one. A checkmark reaction marks completion.

### Continuing a session

Send plain messages in the thread. They are forwarded to Claude Code as follow-up prompts. No slash command needed.

**Important — stateless mode.** In Phase 1, each message in a thread spawns an independent Claude Code process with no memory of previous messages. "Now apply that fix" will not work — Claude Code does not know what fix you mean.

Write every prompt as if talking to a fresh instance:

- Reference specific files and line numbers: `In src/auth.ts line 42, change === to !==`
- Quote the relevant code: paste the snippet from Claude's previous response back into your prompt
- Describe the full change: don't refer to "the fix you suggested" or "the approach above"

A `--resume` spike is planned for Phase 1 to evaluate whether session continuity is feasible. See [Limitations](#limitations-mvp).

### Ending a session with `/claude-end`

Run `/claude-end` inside the thread. The Claude Code process is killed, the thread is archived, and the session is released. Only the session owner or a user with an admin role can end a session.

### Session lock

The first user to start a session in a thread owns it. If another user posts in that thread, the bot replies:

> This session belongs to @owner (active Nm ago). Start your own: `/claude <prompt>` in any channel.

The lock is released when the session ends, when `idleTimeoutSeconds` expires, or when `maxSessionDuration` is reached.

### Session limits

- **`maxSessionDuration`** (default: 3600s) — hard cap. The process is killed after this many seconds regardless of activity.
- **`idleTimeoutSeconds`** (default: 600s) — if the session owner sends no messages for this long, the lock is released and the bot notifies the owner.

## Configuration

Config is loaded from `~/.discord-claude/config.json` (global) merged with `.discord-claude.json` in the project root (project overrides global).

```jsonc
{
  "global": {
    // Discord roles allowed to use the bot
    "allowedRoles": ["developer", "admin"],

    // Max simultaneous Claude Code processes
    "maxConcurrentSessions": 5,

    // Hard session duration cap in seconds
    "maxSessionDuration": 3600,

    // Seconds of owner inactivity before releasing the session lock
    "idleTimeoutSeconds": 600,

    // Regex patterns — matches are redacted from all output before sending to Discord
    "secretPatterns": [
      "sk-[a-zA-Z0-9]+",
      "ghp_[a-zA-Z0-9]+",
      "AKIA[A-Z0-9]+"
    ],

    // Regex to extract cost/token info from Claude Code output (appended to session footer)
    "costPattern": "\\$[\\d.]+|\\d+ tokens?"
  },
  "projects": {
    "my-app": {
      // Absolute path to the project root
      "path": "/home/user/projects/my-app",

      // Named commands for /test, /build, /lint shortcuts
      "commands": {
        "test": "npm test",
        "build": "npm run build",
        "lint": "npx eslint .",
        "typecheck": "npx tsc --noEmit"
      },

      // Skip approval gates for file writes (file deletions always require approval)
      "autoApprove": false,

      // Only these commands can be run via /run
      "allowedShellCommands": ["npm", "npx", "node", "git", "cat", "ls", "grep"]
    }
  }
}
```

## Commands Reference

| Command | Description | Access |
|---|---|---|
| `/claude <prompt>` | Start a new session thread with an initial prompt | Allowed roles |
| `/claude-end` | Terminate session, archive thread | Session owner or admin |
| `/claude-status` | Show session uptime, message count, working directory | Allowed roles |
| `/claude-sessions` | List all active sessions server-wide | Allowed roles |
| `/file <path>` | Display file contents with syntax highlighting | Allowed roles |
| `/tree [path] [depth]` | Show directory structure (respects .gitignore) | Allowed roles |
| `/diff [file]` | Show uncommitted changes | Allowed roles |
| `/git status` | Current branch, staged/unstaged changes | Allowed roles |
| `/git log [n]` | Last N commits as a compact embed | Allowed roles |
| `/git branch` | List branches, highlight current | Allowed roles |
| `/git diff [ref]` | Diff against a ref or uncommitted changes | Allowed roles |
| `/run <command>` | Execute an allowed shell command, stream output | Allowed roles |
| `/test [filter]` | Run configured test command | Allowed roles |
| `/build` | Run configured build command | Allowed roles |
| `/lint [file]` | Run linter on a file or the whole project | Allowed roles |
| `/project list` | List configured projects | Allowed roles |
| `/project switch <name>` | Change active project for new sessions | Allowed roles |
| `/project add <name> <path>` | Register a new project directory | Admin |

## Security

**Secret redaction.** All output passes through configurable regex filters (`secretPatterns`) before any Discord write. Default patterns catch OpenAI keys (`sk-...`), GitHub PATs (`ghp_...`), and AWS access keys (`AKIA...`). Add your own patterns for other secrets.

**Command allowlist.** The `/run` command validates against `allowedShellCommands` before spawning any process. Commands not in the list are rejected outright.

**Path traversal protection.** All file-access commands (`/file`, `/tree`, `/diff`) canonicalize paths and reject anything resolving outside the configured project root.

**Role-based access control.** Only users with roles listed in `allowedRoles` can interact with the bot. Session termination is restricted to the session owner or admin roles.

**Audit logging.** Every command and Claude Code invocation is logged via pino with user ID, timestamp, and working directory.

## Self-Hosting Notes

**pm2 (recommended):**

```sh
npm run build
pm2 start dist/index.js --name claudebot
pm2 save
pm2 startup  # generates a system startup script
```

**systemd:**

Create a unit file at `/etc/systemd/system/claudebot.service` pointing to `node /path/to/dist/index.js` with `Environment=DISCORD_BOT_TOKEN=...`. Run `systemctl enable --now claudebot`.

**PATH and environment.** pm2 and systemd run with a minimal environment — `claude` must be on PATH in the bot's execution environment, not just your interactive shell. Verify with:
```sh
pm2 exec claudebot -- which claude
```
If it fails, set `PATH` explicitly in your pm2 ecosystem file or systemd `Environment=` directive.

**Slash command registration.** On first start, the bot registers slash commands with Discord. Global commands can take up to 1 hour to appear. For faster iteration during development, the bot can register commands as guild-specific (instant). Set `DEV_GUILD_ID=your-server-id` in your environment when running in development mode.

**Logs:** By default, pino writes structured JSON to stdout. Pipe to `pino-pretty` for human-readable output during development, or to a file in production:

```sh
pm2 start dist/index.js --name claudebot --log ~/.discord-claude/bot.log
```

**Orphaned processes.** If the bot crashes without a graceful shutdown, Claude Code subprocesses may persist. After a crash, check for orphaned `claude` processes and kill them manually.

## Limitations (MVP)

- **Stateless sessions.** Each `/claude` invocation starts a fresh Claude Code process with no memory of previous interactions. You must re-provide context manually. A `--resume` spike is planned for Phase 1 to evaluate whether session continuity is feasible.
- **No DM mode.** The bot only works in server channels and threads. Direct message support is planned for Phase 4.
- **No approval gates yet.** Destructive file operations are not yet gated behind Discord confirmation prompts. Planned for Phase 5.
- **No watch/schedule.** `/watch`, `/notify-on-fail`, and `/schedule` are Phase 5 features.
- **No snippet save/replay.** Bookmarking bot output is planned for Phase 5.
- **No image input.** Sending screenshots or photos to Claude Code via Discord attachments is planned for Phase 4.
- **Sessions do not survive restarts.** If the bot restarts, all active sessions are lost. The bot notifies affected threads on startup.
