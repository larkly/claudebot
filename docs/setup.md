# Setup Guide

This guide walks you through the operational prerequisites to run the Discord Claude Code Bot — from zero to a running bot in a test environment.

---

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** or **pnpm** (pnpm preferred for monorepo builds)
- **Claude Code CLI** installed and authenticated on the bot's host machine (`claude --version` must succeed)
- A **Discord account** with permission to create applications and manage a server

---

## 1. Discord Application Setup

### 1.1 Create the Application

1. Navigate to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** → name it (e.g., "Claude Code Bot") → accept terms.
3. In the left sidebar, navigate to **Bot**:
   - Click **Reset Token** to generate a bot token. Copy and store it securely — you'll need it in the Bot Token Handling section below.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent** (required for the bot to read messages in threads).

### 1.2 Configure OAuth2 Scopes

Under **OAuth2 → General**:

| Scope | Required For |
|-------|-------------|
| `bot` | Bot can connect to guilds and read/send messages |
| `applications.commands` | Slash command registration |

### 1.3 Required Bot Permissions

Under **OAuth2 → URL Generator**, select the scopes above, then enable these permissions:

| Permission | Why Needed |
|------------|-----------|
| Send Messages | Bot sends responses in threads |
| Create Public Threads | Bot creates session threads from `/claude` |
| Send Messages in Threads | Bot sends streaming output within threads |
| Manage Threads | Bot manages thread lifecycle (archive, close) |
| Add Reactions | ✅ completion reaction, approval gate reactions |
| Read Message History | Bot reads thread messages for natural language fallback |
| Embed Links | Bot uses embeds for status, sessions, and approval gates |

### 1.4 Generate Invite URL

After selecting scopes and permissions, copy the generated URL at the bottom of **OAuth2 → URL Generator**. Use this URL to invite the bot to your test guild (see section 5.2).

---

## 2. Bot Token Handling

### 2.1 Environment Variable

The bot token is read from the `DISCORD_BOT_TOKEN` environment variable. Never commit the token to version control.

```bash
export DISCORD_BOT_TOKEN="your-bot-token-here"
```

### 2.2 Config File Alternative

The token may also be placed in the bot's configuration file (`~/.discord-claude/config.json`), but this is **not recommended** for shared or production deployments. The environment variable takes precedence.

### 2.3 `.env` File

For local development, copy `.env.example` to `.env` and fill in your token:

```bash
cp .env.example .env
# Edit .env and replace the placeholder with your actual bot token
```

> ⚠️ **Security Note:** `.env` is gitignored and must never be committed. If you accidentally commit a token, revoke it immediately in the Discord Developer Portal and generate a new one.

### 2.4 `.env` Reference

See [`.env.example`](../.env.example) in the repo root for the canonical list of environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token from the Developer Portal |
| `LOG_LEVEL` | No | pino log level (default: `info`; use `debug` during development) |
| `CONFIG_DIR` | No | Override config directory (default: `~/.discord-claude`) |

---

## 3. Slash Command Registration

### 3.1 Guild Commands vs. Global Commands

| Type | Behavior | Use Case |
|------|----------|----------|
| Guild-specific | Available instantly within one guild | Development/QA — fast iteration |
| Global | Propagates to all guilds (~1 hour rollout) | Production |

**For development:** register guild-specific commands in your test guild for instant availability.

**For production:** register global commands once the command surface is stable.

### 3.2 Deploy Script

Slash commands are registered via a standalone deploy script (separate from the bot's main process). This script:

1. Reads command definitions from `src/commands/index.ts`
2. Instantiates a REST client using the bot token and application ID
3. Calls `PUT /applications/{appId}/guilds/{guildId}/commands` (guild) or `PUT /applications/{appId}/commands` (global)
4. Logs the number of commands registered

```bash
# Register commands for a specific guild (development)
npm run deploy:guild -- --guild <GUILD_ID>

# Register commands globally (production)
npm run deploy:global
```

> **Note:** Re-run the deploy script whenever you add, remove, or modify command definitions. The script is idempotent (it replaces all commands with the current set).

### 3.3 Application ID

The Discord Application ID is found in the Developer Portal under **General Information → Application ID**. Set it as an environment variable:

```bash
export DISCORD_APP_ID="your-application-id"
```

---

## 4. Discord Server Setup

### 4.1 Minimum Channel Structure

A test server needs, at minimum:

| Channel | Type | Purpose |
|---------|------|---------|
| `#bot-testing` | Text | Primary channel for invoking `/claude` |

Threads will be created as children of this channel when users invoke `/claude`.

### 4.2 Required Roles

| Role | Purpose |
|------|---------|
| `developer` | Listed in `allowedRoles` config — can start sessions |
| `admin` | Listed in `allowedRoles` config — can start and manage all sessions |

The `allowedRoles` configuration in `~/.discord-claude/config.json` determines which roles can use the bot:

```json
{
  "global": {
    "allowedRoles": ["developer", "admin"]
  }
}
```

Users without one of these roles will receive a "permission denied" message when attempting to use bot commands.

> **Code reference:** RBAC enforcement is implemented in the session manager. The `allowedRoles` array in the global config is checked before any command handler executes. See [CLAUDE.md](../CLAUDE.md#design-decisions) for details.

### 4.3 Permissions for the Bot

Ensure the bot's role (assigned when you invite it through the OAuth2 URL) has the permissions listed in §1.3. Discord will apply these based on the invite URL, but if you manually adjust roles later, verify they haven't been stripped.

---

## 5. Test Guild Setup

### 5.1 Create a Private Test Guild

1. In Discord, click the **+** next to "Servers" in the left sidebar.
2. Click **Create My Own** → name it (e.g., "Claude Bot Dev") → **Create**.
3. Set the server to private (default for user-created servers).

### 5.2 Invite the Bot

Use the OAuth2 URL generated in §1.4. Paste it into your browser:

1. Select your test guild from the dropdown.
2. Click **Authorize**.
3. Complete the CAPTCHA (if shown).
4. You should see the bot appear as "online" in your test guild's member list.

### 5.3 Minimum Configuration for Phase 1 QA

Configure the bot before first run:

1. Create `~/.discord-claude/config.json`:
   ```json
   {
     "global": {
       "allowedRoles": ["developer", "admin"],
       "maxConcurrentSessions": 5,
       "maxSessionDuration": 3600,
       "idleTimeoutSeconds": 600,
       "secretPatterns": ["sk-[a-zA-Z0-9]+", "ghp_[a-zA-Z0-9]+", "AKIA[A-Z0-9]+"]
     },
     "projects": {
       "<test-project-name>": {
         "path": "/absolute/path/to/your/repo",
         "commands": {
           "test": "npm test",
           "build": "npm run build",
           "lint": "npm run lint",
           "typecheck": "npx tsc --noEmit"
         },
         "autoApprove": false,
         "allowedShellCommands": ["npm", "npx", "node", "git", "cat", "ls", "grep"]
       }
     }
   }
   ```

2. Assign yourself the `developer` role (or whichever role you configured in `allowedRoles`).
3. Create a `#bot-testing` text channel.

### 5.4 First-Run Walkthrough

1. **Verify prerequisites:**
   ```bash
   # Claude Code CLI is installed and authenticated
   claude --version

   # Node.js version matches
   node --version  # should be v20+bla
   ```

2. **Set environment variables:**
   ```bash
   export DISCORD_BOT_TOKEN="your-bot-token"
   export DISCORD_APP_ID="your-application-id"
   export LOG_LEVEL="debug"
   ```

3. **Install dependencies:**
   ```bash
   cd /path/to/claudebot
   npm install
   ```

4. **Register slash commands (guild-specific for development):**
   ```bash
   npm run deploy:guild -- --guild <YOUR_TEST_GUILD_ID>
   ```
   Confirm output shows commands registered.

5. **Start the bot:**
   ```bash
   npm run dev
   ```

6. **Verify connectivity:**
   - The bot appears as "online" in your test guild.
   - In `#bot-testing`, type `/claude` and press Tab. You should see autocomplete for the command.

7. **Test the streaming flow (core sanity check):**
   - In `#bot-testing`, invoke `/claude` with a prompt (e.g., "Say hello").
   - Observe: bot creates a thread → sends initial message → edits message as output streams → adds ✅ reaction on completion → cost footer appended.
   - This validates: slash command handling → thread creation → PTY spawn → stream buffer → Discord message editing → completion detection → cost tracking.

8. **Test the approval gate flow (if in Phase 5+):**
   - Invoke a command that triggers an approval gate (e.g., `/run rm -rf /tmp/test`).
   - Observe: bot sends an embed with proceed/cancel reactions → user reacts → command executes or is cancelled.
   - This validates: approval gate rendering → reaction collector → conditional execution.

9. **Check logs:**
   ```bash
   # pino logs should show structured JSON with user, timestamp, workingDirectory
   # Example: {"level":"info","msg":"Session started","user":"...","workingDirectory":"/path","timestamp":"..."}
   ```

### 5.5 Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Bot shows offline after `npm run dev` | Token invalid or network issue | Verify `DISCORD_BOT_TOKEN` matches Developer Portal; check host network allows Discord gateway |
| Slash commands not visible | Commands not registered for guild | Re-run `npm run deploy:guild -- --guild <GUILD_ID>` |
| `/claude` returns "permission denied" | User's Discord roles not in `allowedRoles` | Add the role, or assign yourself `developer`/`admin` role |
| No streaming output | Claude Code CLI not installed or not authenticated | Run `claude --version` and `claude` interactively on the host |
| `ENOENT: spawn claude` error | Claude Code not on PATH | Ensure `claude` is in the system PATH visible to the bot process |
| Thread created but no response | `cwd` not set to valid project path | Check `projects[].path` in config.json points to an existing directory |
| Cost footer missing | `result` event not received | Check Claude Code CLI version supports `--output-format stream-json` and `--resume` |

---

## Next Steps

After first-run verification:

- Review [PROCESS.md](../PROCESS.md) for the development pipeline and QA checklist
- Review [DESIGN.md](../DESIGN.md) for session state, streaming, and security implementation details
- Review [PRD.md](../PRD.md) for the full feature roadmap and phase definitions
- Refer to [CLAUDE.md](../CLAUDE.md) for architecture overview and implementation invariants