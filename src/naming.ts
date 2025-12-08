import type { NamingStrategy } from './config.js';

/**
 * Generate timestamp prefix: YYYYMMDDHHmmss (UTC)
 */
export function generateTimestampPrefix(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/**
 * Generate sequential prefix: 4-digit zero-padded
 */
export function generateSequentialPrefix(existingFiles: string[]): string {
  const seqPattern = /^(\d{4})_.*\.(ts|sql)$/;

  const numbers = existingFiles
    .map((f) => {
      const match = f.match(seqPattern);
      return match ? parseInt(match[1], 10) : NaN;
    })
    .filter((n) => !isNaN(n));

  const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return String(nextNum).padStart(4, '0');
}

/**
 * Generate migration prefix based on strategy
 */
export function generateMigrationPrefix(
  strategy: NamingStrategy,
  existingFiles: string[],
  date?: Date
): string {
  if (strategy === 'timestamp') {
    return generateTimestampPrefix(date);
  }
  return generateSequentialPrefix(existingFiles);
}
