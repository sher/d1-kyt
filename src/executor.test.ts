import { describe, it, expect, vi } from 'vitest';
import { queryAll, queryFirst, queryRun, queryBatch } from './executor.js';
import { createQueryBuilder } from './query-builder.js';
import { defineTable } from './schema.js';
import * as v from 'valibot';

interface TestDB {
  User: {
    id: number;
    name: string;
  };
}

const db = createQueryBuilder<TestDB>();

const ItemTable = defineTable('Item', {
  name: v.string(),
  meta: v.object({ score: v.number() }),
  tags: v.optional(v.array(v.string())),
});

function createMockD1() {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(),
    first: vi.fn(),
    run: vi.fn(),
  };

  const mockDb = {
    prepare: vi.fn().mockReturnValue(mockStatement),
    batch: vi.fn(),
  };

  return { mockDb, mockStatement };
}

describe('queryAll', () => {
  it('executes query and returns results', async () => {
    const { mockDb, mockStatement } = createMockD1();
    const rows = [{ id: 1, name: 'Test' }];
    mockStatement.all.mockResolvedValue({ results: rows, success: true, meta: {} });

    const query = db.selectFrom('User').selectAll().compile();
    const result = await queryAll(mockDb, query);

    expect(mockDb.prepare).toHaveBeenCalledWith('select * from "User"');
    expect(mockStatement.bind).toHaveBeenCalledWith();
    expect(result).toEqual(rows);
  });

  it('binds parameters', async () => {
    const { mockDb, mockStatement } = createMockD1();
    mockStatement.all.mockResolvedValue({ results: [], success: true, meta: {} });

    const query = db.selectFrom('User').selectAll().where('id', '=', 1).compile();
    await queryAll(mockDb, query);

    expect(mockStatement.bind).toHaveBeenCalledWith(1);
  });

  it('returns empty array when results undefined', async () => {
    const { mockDb, mockStatement } = createMockD1();
    mockStatement.all.mockResolvedValue({ success: true, meta: {} });

    const query = db.selectFrom('User').selectAll().compile();
    const result = await queryAll(mockDb, query);

    expect(result).toEqual([]);
  });
});

describe('queryFirst', () => {
  it('returns first row', async () => {
    const { mockDb, mockStatement } = createMockD1();
    const row = { id: 1, name: 'Test' };
    mockStatement.first.mockResolvedValue(row);

    const query = db.selectFrom('User').selectAll().limit(1).compile();
    const result = await queryFirst(mockDb, query);

    expect(result).toEqual(row);
  });

  it('returns null when no row found', async () => {
    const { mockDb, mockStatement } = createMockD1();
    mockStatement.first.mockResolvedValue(null);

    const query = db.selectFrom('User').selectAll().limit(1).compile();
    const result = await queryFirst(mockDb, query);

    expect(result).toBeNull();
  });
});

describe('queryRun', () => {
  it('executes mutation and returns meta', async () => {
    const { mockDb, mockStatement } = createMockD1();
    const meta = {
      duration: 1,
      rows_read: 0,
      rows_written: 1,
      last_row_id: 5,
      changed_db: true,
      changes: 1,
    };
    mockStatement.run.mockResolvedValue({ success: true, meta });

    const query = db.deleteFrom('User').where('id', '=', 1).compile();
    const result = await queryRun(mockDb, query);

    expect(result.success).toBe(true);
    expect(result.meta).toEqual(meta);
  });
});

describe('queryBatch', () => {
  it('executes multiple queries in batch', async () => {
    const { mockDb, mockStatement } = createMockD1();
    const meta = { duration: 1, rows_read: 0, rows_written: 1, last_row_id: 0, changed_db: true, changes: 1 };
    mockDb.batch.mockResolvedValue([
      { success: true, meta },
      { success: true, meta },
    ]);

    const queries = [
      db.insertInto('User').values({ id: 1, name: 'A' }).compile(),
      db.insertInto('User').values({ id: 2, name: 'B' }).compile(),
    ];

    const results = await queryBatch(mockDb, queries);

    expect(mockDb.batch).toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
  });

  it('serializes JSON parameters in batch', async () => {
    const { mockDb, mockStatement } = createMockD1();
    const meta = { duration: 1, rows_read: 0, rows_written: 1, last_row_id: 0, changed_db: true, changes: 1 };
    mockDb.batch.mockResolvedValue([{ success: true, meta }]);

    // Compile a query with an object parameter
    const rawQuery = {
      sql: 'insert into "Item" ("meta") values (?)',
      parameters: [{ score: 42 }] as unknown[],
      query: {} as any,
    };

    await queryBatch(mockDb, [rawQuery]);

    // The statement bind should receive the stringified value, not the raw object
    expect(mockStatement.bind).toHaveBeenCalledWith(JSON.stringify({ score: 42 }));
  });
});

describe('queryAll with table (deserialization)', () => {
  it('deserializes JSON string columns to objects', async () => {
    const { mockDb, mockStatement } = createMockD1();
    const rows = [{ name: 'x', meta: '{"score":10}', tags: null }];
    mockStatement.all.mockResolvedValue({ results: rows, success: true, meta: {} });

    const rawQuery = {
      sql: 'select * from "Item"',
      parameters: [] as unknown[],
      query: {} as any,
    };

    const result = await queryAll(mockDb, rawQuery, ItemTable);

    expect(result[0]).toEqual({ name: 'x', meta: { score: 10 }, tags: null });
  });

  it('returns results as-is without table (backward compat)', async () => {
    const { mockDb, mockStatement } = createMockD1();
    const rows = [{ name: 'x', meta: '{"score":10}' }];
    mockStatement.all.mockResolvedValue({ results: rows, success: true, meta: {} });

    const rawQuery = {
      sql: 'select * from "Item"',
      parameters: [] as unknown[],
      query: {} as any,
    };

    const result = await queryAll(mockDb, rawQuery);

    expect(result[0]).toEqual({ name: 'x', meta: '{"score":10}' });
  });

  it('passes null JSON columns through unchanged', async () => {
    const { mockDb, mockStatement } = createMockD1();
    const rows = [{ name: 'x', meta: '{"score":5}', tags: null }];
    mockStatement.all.mockResolvedValue({ results: rows, success: true, meta: {} });

    const rawQuery = {
      sql: 'select * from "Item"',
      parameters: [] as unknown[],
      query: {} as any,
    };

    const result = await queryAll(mockDb, rawQuery, ItemTable);

    expect(result[0].tags).toBeNull();
  });
});

describe('validator integration', () => {
  it('queryAll throws before executing when query exceeds 100 parameters', async () => {
    const { mockDb } = createMockD1();
    const rawQuery = { sql: 'SELECT 1', parameters: new Array(101).fill(1) as unknown[], query: {} as any };
    await expect(queryAll(mockDb, rawQuery)).rejects.toThrow(/bound parameters/);
  });

  it('queryFirst throws before executing when query exceeds 100 parameters', async () => {
    const { mockDb } = createMockD1();
    const rawQuery = { sql: 'SELECT 1', parameters: new Array(101).fill(1) as unknown[], query: {} as any };
    await expect(queryFirst(mockDb, rawQuery)).rejects.toThrow(/bound parameters/);
  });

  it('queryRun throws before executing when query exceeds 100 parameters', async () => {
    const { mockDb } = createMockD1();
    const rawQuery = { sql: 'SELECT 1', parameters: new Array(101).fill(1) as unknown[], query: {} as any };
    await expect(queryRun(mockDb, rawQuery)).rejects.toThrow(/bound parameters/);
  });

  it('queryBatch throws before executing when any query exceeds 100 parameters', async () => {
    const { mockDb } = createMockD1();
    const valid = { sql: 'SELECT 1', parameters: [] as unknown[], query: {} as any };
    const invalid = { sql: 'SELECT 2', parameters: new Array(101).fill(1) as unknown[], query: {} as any };
    await expect(queryBatch(mockDb, [valid, invalid])).rejects.toThrow(/bound parameters/);
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it('queryAll throws before executing when SQL exceeds 100KB', async () => {
    const { mockDb } = createMockD1();
    const rawQuery = { sql: 'x'.repeat(100_001), parameters: [] as unknown[], query: {} as any };
    await expect(queryAll(mockDb, rawQuery)).rejects.toThrow(/characters/);
    expect(mockDb.prepare).not.toHaveBeenCalled();
  });

  it('accepts custom validators, bypassing defaults', async () => {
    const { mockDb, mockStatement } = createMockD1();
    mockStatement.all.mockResolvedValue({ results: [], success: true, meta: {} });
    // This query has 101 params — would fail defaults, but we pass empty validators
    const rawQuery = { sql: 'SELECT 1', parameters: new Array(101).fill(1) as unknown[], query: {} as any };
    await expect(queryAll(mockDb, rawQuery, undefined, [])).resolves.not.toThrow();
  });
});

describe('queryFirst with table (deserialization)', () => {
  it('deserializes JSON string columns on first row', async () => {
    const { mockDb, mockStatement } = createMockD1();
    mockStatement.first.mockResolvedValue({ name: 'y', meta: '{"score":99}', tags: null });

    const rawQuery = {
      sql: 'select * from "Item" limit 1',
      parameters: [] as unknown[],
      query: {} as any,
    };

    const result = await queryFirst(mockDb, rawQuery, ItemTable);

    expect(result).toEqual({ name: 'y', meta: { score: 99 }, tags: null });
  });

  it('returns null when no row found', async () => {
    const { mockDb, mockStatement } = createMockD1();
    mockStatement.first.mockResolvedValue(null);

    const rawQuery = {
      sql: 'select * from "Item" limit 1',
      parameters: [] as unknown[],
      query: {} as any,
    };

    const result = await queryFirst(mockDb, rawQuery, ItemTable);

    expect(result).toBeNull();
  });
});
