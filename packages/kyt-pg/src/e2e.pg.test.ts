import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as v from 'valibot';
import { freshDb } from '../test/pg.js';
import { expectedFrom } from '../test/columns.js';
import { defineTable, defineIndex } from './schema.js';
import type { InferDB } from './schema.js';
import { defineVirtualTable } from './virtual-table.js';
import { createQueryBuilder } from './query-builder.js';
import { queryAll, queryRun } from './executor.js';
import { serializeSchema, EMPTY_SNAPSHOT } from './snapshot.js';
import { diffSnapshots, applyRenames } from './diff.js';
import type { Rename } from './diff.js';
import { diffToSQL } from './sql.js';
import { migrate } from './migrate.js';

let db: Awaited<ReturnType<typeof freshDb>>;
let dir: string;

beforeAll(async () => {
  db = await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'kyt-pg-e2e-'));
});

afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function expectDatabaseMatches(snapshot: ReturnType<typeof serializeSchema>) {
  const cols = await db.sql`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name <> 'KytMigration'
    order by table_name, column_name`;
  const byName = (a: { table_name: string; column_name: string }, b: typeof a) =>
    a.table_name.localeCompare(b.table_name) || a.column_name.localeCompare(b.column_name);
  expect([...cols]).toEqual(expectedFrom(snapshot).sort(byName));
}

it('goes from schema to typed queries through migrations', async () => {
  const UserV1 = defineTable('User', { email: v.string(), name: v.string() });
  const PostV1 = defineTable(
    'Post',
    { authorId: v.bigint(), title: v.string(), published: v.boolean() },
    { foreignKeys: [{ columns: ['authorId'], references: UserV1, onDelete: 'CASCADE' }] },
  );
  const v1 = serializeSchema({ UserV1, PostV1 });

  writeFileSync(join(dir, '0001.sql'), diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, v1)).join('\n') + '\n');
  expect((await migrate(db.sql, { dir, log: () => {} })).applied).toEqual(['0001.sql']);
  await expectDatabaseMatches(v1);

  const UserV2 = defineTable('User', { email: v.string(), fullName: v.string() });
  const PostV2 = defineTable(
    'Post',
    { authorId: v.bigint(), title: v.string(), published: v.boolean(), summary: v.nullable(v.string()) },
    { foreignKeys: [{ columns: ['authorId'], references: UserV2, onDelete: 'CASCADE' }] },
  );
  defineIndex(PostV2, ['authorId']);
  const PublishedPost = defineVirtualTable('PublishedPost', PostV2, ['authorId', 'title', 'summary'], {
    where: { published: true },
  });
  const v2 = serializeSchema({ UserV2, PostV2 });

  const renames: Rename[] = [{ kind: 'column', table: 'User', from: 'name', to: 'fullName' }];
  const diff = diffSnapshots(applyRenames(v1, renames), v2);
  const lines = diffToSQL(diff, renames);
  expect(lines.some((l) => l.startsWith('-- WARNING'))).toBe(false);
  writeFileSync(join(dir, '0002.sql'), lines.join('\n') + '\n');

  await queryRun(db.sql, createQueryBuilder<any>().insertInto('User').values({ email: 'a@x.io', name: 'Ada' }).compile());
  expect((await migrate(db.sql, { dir, log: () => {} })).applied).toEqual(['0002.sql']);
  await expectDatabaseMatches(v2);

  type DB = InferDB<{ User: typeof UserV2; Post: typeof PostV2 }>;
  const qb = createQueryBuilder<DB & { PublishedPost: DB['Post'] }>([PublishedPost]);

  const [user] = await queryAll(
    db.sql,
    qb.selectFrom('User').select(['id', 'fullName']).where('email', '=', 'a@x.io').compile(),
  );
  expect(user.fullName).toBe('Ada');
  expect(typeof user.id).toBe('bigint');

  const insert = await queryRun(
    db.sql,
    qb
      .insertInto('Post')
      .values([
        { authorId: user.id, title: 'Shown', published: true, summary: 'hi' },
        { authorId: user.id, title: 'Hidden', published: false },
      ])
      .compile(),
  );
  expect(insert.count).toBe(2);

  const rows = await queryAll(
    db.sql,
    qb.selectFrom('PublishedPost').select(['id', 'title', 'summary', 'createdAt']).compile(),
  );
  expect(rows).toHaveLength(1);
  const row = rows[0] as any;
  expect(row.title).toBe('Shown');
  expect(row.summary).toBe('hi');
  expect(typeof row.id).toBe('bigint');
  expect(row.createdAt).toBeInstanceOf(Date);
});
