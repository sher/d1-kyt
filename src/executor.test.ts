import { describe, it, expect, vi } from 'vitest';
import { queryAll, queryFirst, queryRun, queryBatch } from './executor.js';
import { createQueryBuilder } from './query-builder.js';

interface TestDB {
  User: {
    id: number;
    name: string;
  };
}

const db = createQueryBuilder<TestDB>();

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
});
