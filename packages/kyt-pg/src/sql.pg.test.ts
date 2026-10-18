import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { freshDb } from '../test/pg.js';
import { expectedFrom, sorted } from '../test/columns.js';
import { defineTable, defineIndex, defineTrigger, withDefault } from './schema.js';
import { serializeSchema, EMPTY_SNAPSHOT } from './snapshot.js';
import type { SchemaSnapshot } from './snapshot.js';
import { diffSnapshots, applyRenames } from './diff.js';
import type { Rename } from './diff.js';
import { diffToSQL } from './sql.js';

function schemaV1() {
  const User = defineTable('User', { email: v.string(), bio: v.nullable(v.string()) });
  defineIndex(User, ['email'], { unique: true });
  const Post = defineTable(
    'Post',
    { authorId: v.bigint(), title: withDefault(v.string(), 'untitled') },
    { foreignKeys: [{ columns: ['authorId'], references: User, onDelete: 'CASCADE' }] },
  );
  const Audit = defineTable('Audit', { note: v.string() });
  defineTrigger('User_audit', {
    timing: 'AFTER',
    event: 'INSERT',
    on: User,
    body: `INSERT INTO "Audit" ("note") VALUES ('new user');`,
  });
  const Tag = defineTable('Tag', { label: v.string() }, { id: 'uuid' });
  return { Post, User, Audit, Tag };
}

let db: Awaited<ReturnType<typeof freshDb>>;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db.close();
});

async function apply(diff: ReturnType<typeof diffSnapshots>, renames: Rename[] = []) {
  await db.sql.unsafe(diffToSQL(diff, renames).join('\n')).simple();
}

describe('diffToSQL on Postgres', () => {
  const next = serializeSchema(schemaV1());

  it('applies a full schema to an empty database', async () => {
    await apply(diffSnapshots(EMPTY_SNAPSHOT, next));
    const cols = await db.sql`
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`;
    expect([...cols]).toEqual(sorted(expectedFrom(next)));
  });

  it('enforces the unique index, the foreign key and the trigger', async () => {
    const [user] = await db.sql`insert into "User" ("email") values ('a@x.io') returning "id"`;
    await expect(db.sql`insert into "User" ("email") values ('a@x.io')`).rejects.toThrow();
    await expect(db.sql`insert into "Post" ("authorId") values (999)`).rejects.toThrow();
    await db.sql`insert into "Post" ("authorId") values (${user.id})`;
    const [audit] = await db.sql`select count(*)::int as n from "Audit" where "note" = 'new user'`;
    expect(audit.n).toBe(1);
    await db.sql`delete from "User" where "id" = ${user.id}`;
    const [posts] = await db.sql`select count(*)::int as n from "Post"`;
    expect(posts.n).toBe(0);
  });

  it('gives the uuid table a generated id', async () => {
    const [tag] = await db.sql`insert into "Tag" ("label") values ('x') returning "id"`;
    expect(tag.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps updatedAt current', async () => {
    const [user] = await db.sql`insert into "User" ("email") values ('b@x.io') returning "id"`;
    await new Promise((r) => setTimeout(r, 10));
    await db.sql`update "User" set "email" = 'c@x.io' where "id" = ${user.id}`;
    const [row] = await db.sql`select "updatedAt" > "createdAt" as moved from "User" where "id" = ${user.id}`;
    expect(row.moved).toBe(true);
  });

  it('writes nothing when nothing changed', () => {
    expect(diffToSQL(diffSnapshots(next, next))).toEqual([]);
  });
});

describe('renames on Postgres', () => {
  it('keeps data across a column rename', async () => {
    const fresh = await freshDb();
    try {
      const A = defineTable('Member', { name: v.string() });
      const B = defineTable('Member', { fullName: v.string() });
      const v1 = serializeSchema({ A });
      const v2 = serializeSchema({ B });
      await fresh.sql.unsafe(diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, v1)).join('\n')).simple();
      await fresh.sql`insert into "Member" ("name") values ('Ada')`;
      const renames: Rename[] = [{ kind: 'column', table: 'Member', from: 'name', to: 'fullName' }];
      const sql = diffToSQL(diffSnapshots(applyRenames(v1, renames), v2), renames);
      await fresh.sql.unsafe(sql.join('\n')).simple();
      const rows = await fresh.sql`select "fullName" from "Member"`;
      expect(rows.map((r) => r.fullName)).toEqual(['Ada']);
    } finally {
      await fresh.close();
    }
  });

  it('keeps data and the updatedAt trigger across a table rename', async () => {
    const fresh = await freshDb();
    try {
      const A = defineTable('Person', { name: v.string() });
      const B = defineTable('Human', { name: v.string() });
      const v1 = serializeSchema({ A });
      const v2 = serializeSchema({ B });
      await fresh.sql.unsafe(diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, v1)).join('\n')).simple();
      await fresh.sql`insert into "Person" ("name") values ('Ada')`;
      const renames: Rename[] = [{ kind: 'table', from: 'Person', to: 'Human' }];
      const sql = diffToSQL(diffSnapshots(applyRenames(v1, renames), v2), renames);
      await fresh.sql.unsafe(sql.join('\n')).simple();
      await new Promise((r) => setTimeout(r, 10));
      await fresh.sql`update "Human" set "name" = 'Grace'`;
      const [row] = await fresh.sql`select "name", "updatedAt" > "createdAt" as moved from "Human"`;
      expect(row).toEqual({ name: 'Grace', moved: true });
    } finally {
      await fresh.close();
    }
  });
});

describe('column and table changes on Postgres', () => {
  it('applies type, null, default, index, foreign key and drop changes', async () => {
    const fresh = await freshDb();
    try {
      const U1 = defineTable('Owner', { score: v.string(), note: v.nullable(v.string()) });
      const Gone = defineTable('Old', { x: v.string() });
      const v1 = serializeSchema({ U1, Gone });
      await fresh.sql.unsafe(diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, v1)).join('\n')).simple();
      await fresh.sql`insert into "Owner" ("score", "note") values ('5', 'n')`;

      const U2 = defineTable('Owner', { score: v.pipe(v.number(), v.integer()), note: withDefault(v.string(), 'none') });
      defineIndex(U2, ['score']);
      const Item = defineTable(
        'Item',
        { ownerId: v.bigint() },
        { foreignKeys: [{ columns: ['ownerId'], references: U2 }] },
      );
      const v2 = serializeSchema({ U2, Item });
      await fresh.sql`update "Owner" set "note" = 'n'`;
      await fresh.sql.unsafe(diffToSQL(diffSnapshots(v1, v2)).join('\n')).simple();

      const cols = await fresh.sql`
        select column_name, data_type, is_nullable, column_default
        from information_schema.columns where table_name = 'Owner' and column_name in ('score', 'note')
        order by column_name`;
      expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
        ['note', 'text', 'NO'],
        ['score', 'integer', 'NO'],
      ]);
      const [owner] = await fresh.sql`select "score" from "Owner"`;
      expect(owner.score).toBe(5);
      const tables = await fresh.sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
      expect(tables.map((t) => t.table_name)).toEqual(['Item', 'Owner']);
      await expect(fresh.sql`insert into "Item" ("ownerId") values (999)`).rejects.toThrow();
    } finally {
      await fresh.close();
    }
  });
});

describe('foreign keys after renames on Postgres', () => {
  function build(tableName: string, column: string, onDelete?: 'CASCADE' | 'SET NULL', withFk = true) {
    const User = defineTable('User', { email: v.string() });
    const Child = defineTable(
      tableName,
      { [column]: v.nullable(v.bigint()) },
      withFk ? { foreignKeys: [{ columns: [column], references: User, ...(onDelete ? { onDelete } : {}) }] } : {},
    );
    return serializeSchema({ User, Child });
  }

  async function migrate(sql: typeof db.sql, prev: SchemaSnapshot, next: SchemaSnapshot, renames: Rename[] = []) {
    const out = diffToSQL(diffSnapshots(applyRenames(prev, renames), next), renames);
    await sql.unsafe(out.join('\n')).simple();
  }

  async function fkCount(sql: typeof db.sql, table: string) {
    const [row] = await sql`select count(*)::int as n from pg_constraint where conrelid = ${`"${table}"`}::regclass and contype = 'f'`;
    return row.n as number;
  }

  async function cascades(sql: typeof db.sql, table: string, column: string) {
    const [user] = await sql`insert into "User" ("email") values (${`${table}@x.io`}) returning "id"`;
    await sql.unsafe(`insert into "${table}" ("${column}") values (${user.id})`);
    await sql`delete from "User" where "id" = ${user.id}`;
    const [row] = await sql.unsafe(`select count(*)::int as n from "${table}"`);
    return row.n === 0;
  }

  it('changes onDelete after a table rename', async () => {
    const fresh = await freshDb();
    try {
      const v1 = build('Post', 'authorId');
      const v2 = build('Article', 'authorId');
      const v3 = build('Article', 'authorId', 'CASCADE');
      await migrate(fresh.sql, EMPTY_SNAPSHOT, v1);
      await migrate(fresh.sql, v1, v2, [{ kind: 'table', from: 'Post', to: 'Article' }]);
      expect(await fkCount(fresh.sql, 'Article')).toBe(1);
      await migrate(fresh.sql, v2, v3);
      expect(await fkCount(fresh.sql, 'Article')).toBe(1);
      expect(await cascades(fresh.sql, 'Article', 'authorId')).toBe(true);
    } finally {
      await fresh.close();
    }
  });

  it('changes onDelete after a column rename', async () => {
    const fresh = await freshDb();
    try {
      const v1 = build('Post', 'writerId');
      const v2 = build('Post', 'authorId');
      const v3 = build('Post', 'authorId', 'CASCADE');
      await migrate(fresh.sql, EMPTY_SNAPSHOT, v1);
      await migrate(fresh.sql, v1, v2, [{ kind: 'column', table: 'Post', from: 'writerId', to: 'authorId' }]);
      expect(await fkCount(fresh.sql, 'Post')).toBe(1);
      await migrate(fresh.sql, v2, v3);
      expect(await fkCount(fresh.sql, 'Post')).toBe(1);
      expect(await cascades(fresh.sql, 'Post', 'authorId')).toBe(true);
    } finally {
      await fresh.close();
    }
  });

  it('drops the foreign key after a table rename', async () => {
    const fresh = await freshDb();
    try {
      const v1 = build('Post', 'authorId');
      const v2 = build('Article', 'authorId');
      const v3 = build('Article', 'authorId', undefined, false);
      await migrate(fresh.sql, EMPTY_SNAPSHOT, v1);
      await migrate(fresh.sql, v1, v2, [{ kind: 'table', from: 'Post', to: 'Article' }]);
      await migrate(fresh.sql, v2, v3);
      expect(await fkCount(fresh.sql, 'Article')).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
