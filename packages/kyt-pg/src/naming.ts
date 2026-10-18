import type { NamingStrategy } from './config.js';
import type { SchemaDiff } from './diff.js';

export function generateTimestampPrefix(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

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

export function toSnake(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
}

export function generateDiffName(diff: SchemaDiff): string {
  const parts = [
    ...diff.addedTables.map((t) => `create_${toSnake(t.name)}`),
    ...diff.droppedTables.map((t) => `drop_${toSnake(t.name)}`),
    ...diff.changedTables.map((t) => `alter_${toSnake(t.name)}`),
  ];
  if (parts.length === 0) return 'update_schema';
  if (parts.length <= 3) return parts.join('_and_');
  return 'update_schema';
}
