/**
 * Claudebot - Discord Claude Code Bot
 * Entry point stub (Phase 0: Project Setup)
 *
 * This file will be expanded in Phase 1 (Core Loop) to:
 * - Initialize Discord client
 * - Listen for /claude slash commands
 * - Spawn Claude Code CLI per session via node-pty
 * - Stream output to Discord threads
 *
 * @see PRD.md for full feature specification
 * @see DESIGN.md for architecture decisions
 */

const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
};

async function main(): Promise<void> {
  logger.info('Claudebot starting up (Phase 0: stub)');

  // Phase 0: Verify environment
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  const claudePath = process.env.CLAUDE_PATH ?? 'claude';

  if (!discordToken) {
    logger.error('DISCORD_BOT_TOKEN environment variable is required');
    process.exit(1);
  }

  logger.info(`Claude CLI path: ${claudePath}`);
  logger.info('Phase 0 stub ready. Implementation begins in Phase 1.');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Fatal error: ${message}`);
  process.exit(1);
});
