/**
 * Secret redaction middleware.
 * Must run before every Discord write — never rely on log-layer filtering alone.
 * @see CLAUDE.md > Implementation Invariants
 */

import type { GlobalConfig } from './types.js';

/**
 * Redact known secret patterns from a text string.
 * Replaces matches with `[REDACTED]`.
 */
export function redactSecrets(
  text: string,
  patterns: string[] = [],
): string {
  if (!patterns.length) return text;
  let result = text;
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, 'g');
      result = result.replace(regex, '[REDACTED]');
    } catch {
      // Invalid regex pattern — skip it
    }
  }
  return result;
}

/** Create a redaction function bound to the global config's patterns. */
export function createRedactor(config: GlobalConfig) {
  const patterns = config.secretPatterns ?? [];
  return (text: string): string => redactSecrets(text, patterns);
}
