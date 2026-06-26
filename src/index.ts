/**
 * Claudebot - Discord Claude Code Bot
 * Entry point
 *
 * Phase 1: Core loop — /claude command, streaming, session management, RBAC,
 * natural language fallback, persistent sessions, cost tracking.
 *
 * @see PRD.md for full feature specification
 * @see DESIGN.md for architecture decisions
 * @see CLAUDE.md for development guidance
 */

import pino from 'pino';
import { loadConfig, ensureConfigDir } from './config.js';
import { createBot } from './bot.js';

const logger = pino({ name: 'claudebot:main' });

async function main(): Promise<void> {
  logger.info('Claudebot starting up (Phase 1: Core Loop)');

  // Verify required environment variables
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  const claudePath = process.env.CLAUDE_PATH ?? 'claude';

  if (!discordToken) {
    logger.error('DISCORD_BOT_TOKEN environment variable is required');
    process.exit(1);
  }

  logger.info({ claudePath }, 'Claude CLI path configured');

  // Ensure config directory exists
  ensureConfigDir();

  // Load configuration
  const config = loadConfig();
  logger.info(
    {
      maxConcurrentSessions: config.global.maxConcurrentSessions,
      maxSessionDuration: config.global.maxSessionDuration,
      idleTimeoutSeconds: config.global.idleTimeoutSeconds,
      projectCount: Object.keys(config.projects).length,
    },
    'Configuration loaded',
  );

  // Create and start the bot
  const client = createBot(config);

  try {
    await client.login(discordToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Failed to login to Discord');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    client.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, 'Fatal error');
  process.exit(1);
});
