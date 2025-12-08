import { describe, it, expect } from 'vitest';
import {
  generateTimestampPrefix,
  generateSequentialPrefix,
  generateMigrationPrefix,
} from './naming.js';

describe('generateTimestampPrefix', () => {
  it('formats date as YYYYMMDDHHmmss UTC', () => {
    const date = new Date('2024-03-15T09:05:30Z');
    const result = generateTimestampPrefix(date);
    expect(result).toBe('20240315090530');
  });

  it('pads single-digit values', () => {
    const date = new Date('2024-01-05T01:02:03Z');
    const result = generateTimestampPrefix(date);
    expect(result).toBe('20240105010203');
  });

  it('returns 14-character string', () => {
    const result = generateTimestampPrefix();
    expect(result).toMatch(/^\d{14}$/);
  });
});

describe('generateSequentialPrefix', () => {
  it('returns 0001 for empty list', () => {
    const result = generateSequentialPrefix([]);
    expect(result).toBe('0001');
  });

  it('increments from highest existing number', () => {
    const files = ['0001_create_users.ts', '0002_add_posts.sql'];
    const result = generateSequentialPrefix(files);
    expect(result).toBe('0003');
  });

  it('handles gaps in sequence', () => {
    const files = ['0001_first.ts', '0005_fifth.ts'];
    const result = generateSequentialPrefix(files);
    expect(result).toBe('0006');
  });

  it('ignores non-matching files', () => {
    const files = ['0001_valid.ts', 'readme.md', 'config.json', '0002_also_valid.sql'];
    const result = generateSequentialPrefix(files);
    expect(result).toBe('0003');
  });

  it('handles mixed ts and sql files', () => {
    const files = ['0001_first.ts', '0002_second.sql', '0003_third.ts'];
    const result = generateSequentialPrefix(files);
    expect(result).toBe('0004');
  });
});

describe('generateMigrationPrefix', () => {
  it('uses timestamp strategy', () => {
    const date = new Date('2024-06-20T14:30:00Z');
    const result = generateMigrationPrefix('timestamp', [], date);
    expect(result).toBe('20240620143000');
  });

  it('uses sequential strategy', () => {
    const files = ['0001_first.ts', '0002_second.ts'];
    const result = generateMigrationPrefix('sequential', files);
    expect(result).toBe('0003');
  });

  it('defaults to 0001 for sequential with no files', () => {
    const result = generateMigrationPrefix('sequential', []);
    expect(result).toBe('0001');
  });
});
