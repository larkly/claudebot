/**
 * Discord bot layer — slash commands, thread management, message editing,
 * streaming, and natural language fallback.
 *
 * Phase 1 implements:
 * - /claude <prompt>: Start a new Claude Code session in a thread
 * - /claude-end: End the current session
 * - Natural language fallback: plain messages in session threads forwarded as prompts
 * - Streaming output with ~1.5s flush and message editing
 * - Cost tracking footer
 * - Session persistence across restarts
 *
 * @see CLAUDE.md > Architecture
 * @see DESIGN.md for all design decisions
 */

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Events,
  type ChatInputCommandInteraction,
  type Message,
  type ThreadChannel,
  REST,
  Routes,
  AttachmentBuilder,
} from 'discord.js';
import pino from 'pino';
import type { AppConfig } from './types.js';
import { SessionManager } from './session.js';
import { spawnClaude, checkClaudeAvailable } from './process.js';
import { createRedactor } from './redaction.js';
import { readPersistedThreads } from './persistence.js';

const FLUSH_INTERVAL_MS = 1500;

/** Build the slash commands for registration. */
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('claude')
      .setDescription('Start a Claude Code session in a thread')
      .addStringOption((opt) =>
        opt.setName('prompt').setDescription('Your prompt for Claude').setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('claude-end')
      .setDescription('End the active Claude session in this thread')
      .toJSON(),
  ];
}

/** Create and configure the Discord client. */
export function createBot(config: AppConfig): Client {
  const logger = pino({ name: 'claudebot' });
  const sessions = new SessionManager(config);
  const redact = createRedactor(config.global);

  // Determine the claude CLI path
  const claudePath = process.env.CLAUDE_PATH ?? 'claude';

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  // --- Slash command handler ---
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmdInteraction = interaction as ChatInputCommandInteraction;

    if (cmdInteraction.commandName === 'claude') {
      await handleClaudeCommand(cmdInteraction, config, sessions, redact, claudePath, logger);
    } else if (cmdInteraction.commandName === 'claude-end') {
      await handleClaudeEndCommand(cmdInteraction, sessions, logger);
    }
  });

  // --- Natural language fallback handler ---
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    await handleNaturalLanguageMessage(message, sessions, config, redact, claudePath, logger);
  });

  // --- Ready handler ---
  client.once(Events.ClientReady, async (c) => {
    logger.info({ user: c.user.tag }, 'Bot online');

    // Register slash commands globally
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);
    try {
      await rest.put(Routes.applicationCommands(c.user.id), { body: buildCommands() });
      logger.info('Slash commands registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register slash commands');
    }

    // Recover sessions from persisted state
    await recoverSessions(c, sessions, config, redact, claudePath, logger);

    // Verify claude CLI is available
    const available = await checkClaudeAvailable(claudePath);
    if (!available) {
      logger.warn({ claudePath }, 'Claude CLI not found at path — sessions will fail at spawn time');
    }
  });

  return client;
}

/** /claude command — start a new session. */
async function handleClaudeCommand(
  interaction: ChatInputCommandInteraction,
  config: AppConfig,
  sessions: SessionManager,
  redact: (text: string) => string,
  claudePath: string,
  logger: pino.Logger,
): Promise<void> {
  const prompt = interaction.options.getString('prompt', true);
  const userId = interaction.user.id;

  // Check capacity
  if (sessions.isAtCapacity()) {
    await interaction.reply({
      content: '⚠️ Maximum concurrent sessions reached. Please wait for an existing session to end.',
      ephemeral: true,
    });
    return;
  }

  // Determine project (use the first configured project as default for Phase 1)
  const projectNames = Object.keys(config.projects);
  if (projectNames.length === 0) {
    await interaction.reply({
      content: '⚠️ No projects configured. Add a project to ~/.discord-claude/config.json first.',
      ephemeral: true,
    });
    return;
  }
  const projectName = projectNames[0];
  const projectConfig = config.projects[projectName];

  // Create the thread from the initial reply
  const threadName = `Claude: ${prompt.slice(0, 50)}${prompt.length > 50 ? '…' : ''}`;

  // Reply first (must be a regular message, not ephemeral)
  const safePrompt = redact(prompt);
  await interaction.reply(`🤖 **Starting Claude Code session…**\n\n> ${safePrompt}`);

  const reply = await interaction.fetchReply();

  // Create a public thread on the reply message
  const thread = await reply.startThread({
    name: threadName,
    autoArchiveDuration: 60,
  });

  // Create the session
  const session = sessions.createSession({
    threadId: thread.id,
    ownerId: userId,
    projectName,
  });

  logger.info(
    { user: userId, threadId: thread.id, project: projectName, timestamp: new Date().toISOString() },
    'Session created',
  );

  // Start the Claude process
  await startClaudeInvocation(
    thread,
    session.claudeSessionId,
    prompt,
    projectConfig.path,
    claudePath,
    sessions,
    redact,
    logger,
    userId,
  );
}

/** /claude-end command — end the active session. */
async function handleClaudeEndCommand(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager,
  logger: pino.Logger,
): Promise<void> {
  const threadId = interaction.channelId;

  if (!sessions.has(threadId)) {
    await interaction.reply({
      content: 'No active session in this thread.',
      ephemeral: true,
    });
    return;
  }

  // Only the owner or someone with admin role can end
  if (!sessions.isOwner(threadId, interaction.user.id)) {
    const session = sessions.get(threadId);
    const ownerMention = `<@${session?.ownerId}>`;
    await interaction.reply(
      `🔒 This session belongs to ${ownerMention}. Only the owner can end it.`,
    );
    return;
  }

  sessions.destroy(threadId);
  logger.info({ threadId }, 'Session ended by user');
  await interaction.reply('✅ Session ended. Thread is now available.');
}

/** Natural language fallback — plain messages in session threads. */
async function handleNaturalLanguageMessage(
  message: Message,
  sessions: SessionManager,
  config: AppConfig,
  redact: (text: string) => string,
  claudePath: string,
  logger: pino.Logger,
): Promise<void> {
  // Check 1: Is this in a thread?
  if (!message.channel.isThread()) return;

  const threadId = message.channel.id;

  // Check 2: Is there an active session for this thread?
  if (!sessions.has(threadId)) return;

  const session = sessions.get(threadId)!;

  // Check 3: Is this the session owner?
  if (message.author.id !== session.ownerId) {
    // Non-owner posting → send lock message
    const minutesActive = Math.round((Date.now() - session.lastActivityAt) / 60000);
    await message.channel.send(
      `🔒 This session belongs to <@${session.ownerId}> (active ${minutesActive}m ago). Start your own: \`/claude <prompt>\` in any channel.`,
    );
    return;
  }

  // Check 4: Should already be filtered (not a bot), but double-check
  if (message.author.bot) return;

  // The message is from the session owner in an active thread — forward as prompt
  let prompt = message.content;
  if (prompt.length < 10) {
    prompt = `⚠️ Short prompt forwarded to Claude.\n\n${prompt}`;
  }

  // Reset the idle timer
  sessions.resetIdleTimer(threadId);

  // Get project config
  const projectConfig = config.projects[session.projectName];
  if (!projectConfig) {
    logger.error({ projectName: session.projectName }, 'Project config not found');
    await message.channel.send('❌ Project configuration not found. Session may be stale.');
    return;
  }

  await startClaudeInvocation(
    message.channel as ThreadChannel,
    session.claudeSessionId,
    message.content, // raw prompt without the warning prefix
    projectConfig.path,
    claudePath,
    sessions,
    redact,
    logger,
    session.ownerId,
  );
}

/**
 * Spawn a Claude Code CLI process and stream output to the Discord thread.
 * This is the core streaming loop.
 */
async function startClaudeInvocation(
  thread: ThreadChannel,
  claudeSessionId: string | null,
  prompt: string,
  cwd: string,
  claudePath: string,
  sessions: SessionManager,
  redact: (text: string) => string,
  logger: pino.Logger,
  userId: string,
): Promise<void> {
  const threadId = thread.id;
  const session = sessions.get(threadId);
  if (!session) return;

  // Send initial message
  const botMessage = await thread.send('🤖 *Thinking…*');
  session.currentMessageId = botMessage.id;

  // Buffer for streaming output
  session.outputBuffer = '';
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let lastFlushedLength = 0;

  // Set up flush interval (~1.5s as per design)
  flushTimer = setInterval(async () => {
    if (session.outputBuffer.length > lastFlushedLength) {
      const content = redact(session.outputBuffer.slice(0, 2000)); // Discord 2000 char limit
      try {
        await botMessage.edit(content || '🤖 *Thinking…*');
        lastFlushedLength = session.outputBuffer.length;
      } catch (err) {
        logger.debug({ err }, 'Failed to edit streaming message (may be rate-limited)');
      }
    }
  }, FLUSH_INTERVAL_MS);

  // Spawn the Claude process
  const proc = spawnClaude(prompt, cwd, claudeSessionId, claudePath, {
    onSessionId: (sid) => {
      sessions.setClaudeSessionId(threadId, sid);
      logger.info({ threadId, sessionId: sid }, 'Obtained Claude session ID');
    },
    onAssistantText: (text) => {
      session.outputBuffer += text;
    },
    onResult: async (result, costUsd) => {
      // Clear the flush timer
      if (flushTimer) clearInterval(flushTimer);

      // Final message with cost footer
      let finalContent = result || session.outputBuffer;
      if (!finalContent) {
        finalContent = '(no output)';
      }

      // Add cost footer
      if (costUsd !== null && costUsd > 0) {
        finalContent += `\n\n---\n💰 Cost: $${costUsd.toFixed(4)}`;
      }

      finalContent = redact(finalContent).slice(0, 2000);

      try {
        await botMessage.edit(finalContent);
      } catch (err) {
        logger.error({ err }, 'Failed to send final result');
      }

      // Add ✅ reaction
      try {
        await botMessage.react('✅');
      } catch {
        // Reactions may fail in some channel types
      }

      logger.info(
        { threadId, userId, cost: costUsd, timestamp: new Date().toISOString() },
        'Session invocation complete',
      );
    },
    onError: async (error) => {
      if (flushTimer) clearInterval(flushTimer);
      logger.error({ threadId, error }, 'Claude process error');
      try {
        await botMessage.edit(`❌ Error: ${redact(error).slice(0, 1900)}`);
      } catch {
        // Message may have been deleted
      }
    },
    onExit: (exitCode) => {
      if (flushTimer) clearInterval(flushTimer);
      session.ptyProcess = null;
      logger.debug({ threadId, exitCode }, 'Claude process exited');
    },
  });

  // Store the PTY process handle
  session.ptyProcess = proc;

  // If this was a first invocation (no claudeSessionId), the onSessionId callback
  // will set it. For subsequent invocations (--resume), the ID is already set.
}

/**
 * Recover sessions from persisted state after a bot restart.
 * Reads active-threads.json and attempts to re-register each thread.
 */
async function recoverSessions(
  client: Client,
  sessions: SessionManager,
  config: AppConfig,
  redact: (text: string) => string,
  claudePath: string,
  logger: pino.Logger,
): Promise<void> {
  const persisted = readPersistedThreads();
  if (persisted.length === 0) {
    logger.info('No persisted sessions to recover');
    return;
  }

  logger.info({ count: persisted.length }, 'Recovering persisted sessions');

  for (const thread of persisted) {
    // Re-create the session in the manager (without spawning a process)
    if (!config.projects[thread.projectName]) {
      logger.warn(
        { threadId: thread.threadId, projectName: thread.projectName },
        'Project no longer configured — skipping recovery',
      );
      continue;
    }

    // We can't fully recreate the SessionState with timers without a live
    // Discord channel reference. For Phase 1, we just re-register the session
    // metadata. The next message from the owner will trigger --resume.
    sessions.createSession({
      threadId: thread.threadId,
      ownerId: thread.ownerId,
      projectName: thread.projectName,
    });

    // Set the Claude session ID from persistence
    if (thread.claudeSessionId) {
      sessions.setClaudeSessionId(thread.threadId, thread.claudeSessionId);
    }

    logger.info({ threadId: thread.threadId }, 'Session recovered');
  }
}

export { buildCommands };
