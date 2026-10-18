import type { ColumnType, GeneratedAlways } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../test/pg.js';
import { queryAll, queryBatch, queryFirst, queryRun } from './executor.js';
import { createQueryBuilder } from './query-builder.js';

type DB = {
  Item: {
    id: GeneratedAlways<bigint>;
    name: string;
    done: boolean;
    meta: ColumnType<unknown, unknown, unknown> | null;
    tags: ColumnType<unknown, unknown, unknown> | null;
    dueAt: Date | null;
  };
};

const db = createQueryBuilder<DB>();

describe('query helpers', () => {
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  let sql: typeof fresh.sql;

  beforeEach(async () => {
    fresh = await freshDb();
    sql = fresh.sql;
    await sql.unsafe(
      'create table "Item" ("id" bigint generated always as identity primary key, "name" text not null, "done" boolean not null, "meta" jsonb, "tags" jsonb, "dueAt" timestamptz)',
    );
  });

  afterEach(async () => {
    await fresh.close();
  });

  it('round-trips every column type', async () => {
    const due = new Date('2026-01-02T03:04:05.000Z');
    const ins = db
      .insertInto('Item')
      .values({ name: 'a', done: true, meta: { k: 'v' }, tags: ['x', 'y'], dueAt: due })
      .returning('id')
      .compile();
    const { id } = (await queryFirst(sql, ins))!;
    expect(typeof id).toBe('bigint');
    const row = await queryFirst(sql, db.selectFrom('Item').selectAll().where('id', '=', id).compile());
    expect(row).toEqual({ id, name: 'a', done: true, meta: { k: 'v' }, tags: ['x', 'y'], dueAt: due });
  });

  it('stores objects and arrays as JSON, not as text', async () => {
    await queryRun(sql, db.insertInto('Item').values({ name: 'a', done: false, meta: { k: 'v' }, tags: ['x'] }).compile());
    const [r] = await sql`select jsonb_typeof("meta") as m, jsonb_typeof("tags") as t from "Item"`;
    expect(r).toEqual({ m: 'object', t: 'array' });
  });

  it('returns undefined when no row matches', async () => {
    expect(await queryFirst(sql, db.selectFrom('Item').selectAll().where('id', '=', 999n).compile())).toBeUndefined();
  });

  it('returns the changed row count', async () => {
    await queryRun(sql, db.insertInto('Item').values({ name: 'a', done: false }).compile());
    await queryRun(sql, db.insertInto('Item').values({ name: 'b', done: false }).compile());
    expect(await queryRun(sql, db.updateTable('Item').set({ done: true }).compile())).toEqual({ count: 2 });
  });

  it('rolls back the whole batch when one query fails', async () => {
    const good = db.insertInto('Item').values({ name: 'a', done: false }).compile();
    const bad = db.insertInto('Item').values({ name: null as any, done: false }).compile();
    await expect(queryBatch(sql, [good, bad])).rejects.toThrow();
    expect(await queryAll(sql, db.selectFrom('Item').selectAll().compile())).toEqual([]);
  });

  it('runs inside a caller transaction', async () => {
    await sql.begin(async (tx) => {
      await queryRun(tx, db.insertInto('Item').values({ name: 'a', done: false }).compile());
    });
    expect((await queryAll(sql, db.selectFrom('Item').selectAll().compile())).length).toBe(1);
  });
});
