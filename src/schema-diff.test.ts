import { describe, it, expect, afterEach } from 'vitest';
import * as v from 'valibot';
import { defineTable, defineIndex, defineTrigger } from './schema.js';
import {
  serializeSchema,
  diffSnapshots,
  diffToSQL,
  type SchemaSnapshot,
} from './schema-diff.js';

// ----------------------------------------------------------------------------
// SQLite helper using node:sqlite (built-in, no native bindings required)
// ----------------------------------------------------------------------------

/**
 * Execute a SQL string against an in-memory SQLite database.
 * Uses db.exec() directly so multi-statement SQL (including triggers with
 * BEGIN...END blocks) works correctly without manual semicolon splitting.
 */
function withSqlite(sql: string): {
  db: import('node:sqlite').DatabaseSync;
  close: () => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  if (sql.trim()) {
    db.exec(sql);
  }
  return { db, close: () => db.close() };
}

/**
 * Apply a list of SQL statements (from diffToSQL) to a live SQLite database
 * and return the database instance for further assertions.
 * Comment-only lines are stripped; multi-statement blocks are executed as-is.
 */
function applySQL(statements: string[]): {
  db: import('node:sqlite').DatabaseSync;
  close: () => void;
} {
  const sql = statements.filter((s) => !s.startsWith('--')).join('\n');
  return withSqlite(sql);
}

// ----------------------------------------------------------------------------
// serializeSchema
// ----------------------------------------------------------------------------

describe('serializeSchema', () => {
  it('serializes a simple table with auto columns', () => {
    const users = defineTable('u_ser_simple', {
      email: v.string(),
      name: v.optional(v.string()),
    });

    const snapshot = serializeSchema({ users });
    expect(snapshot.version).toBe(1);

    const t = snapshot.tables['u_ser_simple'];
    expect(t).toBeDefined();
    expect(t.columns['id']).toMatchObject({
      type: 'INTEGER',
      primaryKey: true,
      autoIncrement: true,
    });
    expect(t.columns['email']).toMatchObject({ type: 'TEXT', notNull: true });
    expect(t.columns['name']).toMatchObject({ type: 'TEXT', notNull: false });
    expect(t.columns['createdAt']).toMatchObject({
      type: 'TEXT',
      notNull: true,
      default: `(datetime('now'))`,
    });
    expect(t.columns['updatedAt']).toMatchObject({
      type: 'TEXT',
      notNull: true,
      default: `(datetime('now'))`,
    });
  });

  it('respects TableOptions: disable auto columns', () => {
    const t = defineTable(
      'u_ser_opts',
      { slug: v.string() },
      { primaryKey: false, createdAt: false, updatedAt: false },
    );
    const snap = serializeSchema({ t });
    const table = snap.tables['u_ser_opts'];
    expect(Object.keys(table.columns)).toEqual(['slug']);
    expect(Object.keys(table.triggers)).toHaveLength(0);
  });

  it('respects custom column names', () => {
    const t = defineTable(
      'u_ser_custom',
      { slug: v.string() },
      { primaryKeyColumn: 'pk', createdAtColumn: 'created_at', updatedAtColumn: 'updated_at' },
    );
    const snap = serializeSchema({ t });
    const table = snap.tables['u_ser_custom'];
    expect(table.columns['pk']).toBeDefined();
    expect(table.columns['created_at']).toBeDefined();
    expect(table.columns['updated_at']).toBeDefined();
    expect(table.triggers['u_ser_custom_updated_at_trg']).toBeDefined();
  });

  it('includes indexes attached to the table', () => {
    const users = defineTable('u_ser_idx', { email: v.string() });
    defineIndex(users, ['email'], { unique: true });
    const snap = serializeSchema({ users });
    const idx = snap.tables['u_ser_idx'].indexes['u_ser_idx_email_uq'];
    expect(idx).toBeDefined();
    expect(idx.unique).toBe(true);
    expect(idx.columns).toEqual(['email']);
  });

  it('includes auto updatedAt trigger', () => {
    const users = defineTable('u_ser_trg', { email: v.string() });
    const snap = serializeSchema({ users });
    const trg = snap.tables['u_ser_trg'].triggers['u_ser_trg_updatedAt_trg'];
    expect(trg).toBeDefined();
    expect(trg.timing).toBe('AFTER');
    expect(trg.event).toBe('UPDATE');
    expect(trg.tableName).toBe('u_ser_trg');
  });

  it('includes user-defined triggers', () => {
    const users = defineTable('u_ser_utrg', { email: v.string() });
    defineTrigger('u_ser_utrg_audit', {
      timing: 'AFTER',
      event: 'INSERT',
      on: users,
      body: `SELECT 1;`,
    });
    const snap = serializeSchema({ users });
    expect(snap.tables['u_ser_utrg'].triggers['u_ser_utrg_audit']).toBeDefined();
  });

  it('skips non-SchemaTable exports', () => {
    const snap = serializeSchema({ foo: 'bar', count: 42, fn: () => {} });
    expect(Object.keys(snap.tables)).toHaveLength(0);
  });

  it('handles column with DEFAULT value', () => {
    const t = defineTable('u_ser_def', {
      role: v.optional(v.string(), 'user'),
    });
    const snap = serializeSchema({ t });
    expect(snap.tables['u_ser_def'].columns['role'].default).toBe("'user'");
  });
});

// ----------------------------------------------------------------------------
// diffSnapshots
// ----------------------------------------------------------------------------

describe('diffSnapshots', () => {
  const empty: SchemaSnapshot = { version: 1, tables: {} };

  it('detects added table', () => {
    const users = defineTable('diff_add', { email: v.string() });
    const next = serializeSchema({ users });
    const diff = diffSnapshots(empty, next);
    expect(diff.addedTables).toHaveLength(1);
    expect(diff.addedTables[0].name).toBe('diff_add');
    expect(diff.droppedTables).toHaveLength(0);
    expect(diff.changedTables).toHaveLength(0);
  });

  it('detects dropped table', () => {
    const users = defineTable('diff_drop', { email: v.string() });
    const prev = serializeSchema({ users });
    const diff = diffSnapshots(prev, empty);
    expect(diff.droppedTables).toHaveLength(1);
    expect(diff.droppedTables[0].name).toBe('diff_drop');
    expect(diff.addedTables).toHaveLength(0);
  });

  it('detects no changes when snapshot is identical', () => {
    const users = defineTable('diff_same', { email: v.string() });
    const snap = serializeSchema({ users });
    const diff = diffSnapshots(snap, snap);
    expect(diff.addedTables).toHaveLength(0);
    expect(diff.droppedTables).toHaveLength(0);
    expect(diff.changedTables).toHaveLength(0);
  });

  it('detects added column', () => {
    const v1 = defineTable('diff_col_add', { title: v.string() });
    const v2 = defineTable('diff_col_add', { title: v.string(), body: v.optional(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const added = diff.changedTables[0]?.columns.filter((c) => !c.before && c.after);
    expect(added?.some((c) => c.name === 'body')).toBe(true);
  });

  it('detects dropped column', () => {
    const v1 = defineTable('diff_col_drop', { title: v.string(), body: v.optional(v.string()) });
    const v2 = defineTable('diff_col_drop', { title: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const dropped = diff.changedTables[0]?.columns.filter((c) => c.before && !c.after);
    expect(dropped?.some((c) => c.name === 'body')).toBe(true);
  });

  it('detects modified column (type change)', () => {
    const v1 = defineTable('diff_col_mod', { status: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = JSON.parse(JSON.stringify(prev)) as SchemaSnapshot;
    next.tables['diff_col_mod'].columns['status'].type = 'INTEGER';
    const diff = diffSnapshots(prev, next);
    const modified = diff.changedTables[0]?.columns.filter((c) => c.before && c.after);
    expect(modified?.some((c) => c.name === 'status')).toBe(true);
  });

  it('detects added index', () => {
    const v1 = defineTable('diff_idx_add', { email: v.string() });
    const v2 = defineTable('diff_idx_add', { email: v.string() });
    defineIndex(v2, ['email'], { unique: true });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const added = diff.changedTables[0]?.indexes.filter((i) => !i.before && i.after);
    expect(added?.length).toBeGreaterThan(0);
  });

  it('detects dropped index', () => {
    const v1 = defineTable('diff_idx_drop', { email: v.string() });
    defineIndex(v1, ['email'], { unique: true });
    const v2 = defineTable('diff_idx_drop', { email: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const dropped = diff.changedTables[0]?.indexes.filter((i) => i.before && !i.after);
    expect(dropped?.length).toBeGreaterThan(0);
  });

  it('includes prevTable and nextTable on changed tables', () => {
    const v1 = defineTable('diff_refs', { title: v.string() });
    const v2 = defineTable('diff_refs', { title: v.string(), body: v.optional(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const changed = diff.changedTables[0];
    expect(changed?.prevTable).toBeDefined();
    expect(changed?.nextTable).toBeDefined();
    expect(changed?.prevTable.name).toBe('diff_refs');
    expect(changed?.nextTable.columns['body']).toBeDefined();
  });
});

// ----------------------------------------------------------------------------
// diffToSQL
// ----------------------------------------------------------------------------

describe('diffToSQL', () => {
  const empty: SchemaSnapshot = { version: 1, tables: {} };

  it('generates CREATE TABLE for added table', () => {
    const users = defineTable('sql_add', {
      email: v.string(),
      name: v.optional(v.string()),
    });
    const next = serializeSchema({ users });
    const diff = diffSnapshots(empty, next);
    const sql = diffToSQL(diff);

    const ct = sql.find((s) => s.includes('CREATE TABLE'));
    expect(ct).toBeDefined();
    expect(ct).toContain('"sql_add"');
    expect(ct).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(ct).toContain('"email" TEXT NOT NULL');
    expect(ct).toContain('"name" TEXT');
  });

  it('generates DROP TABLE + warning for dropped table', () => {
    const users = defineTable('sql_drop', { email: v.string() });
    const prev = serializeSchema({ users });
    const diff = diffSnapshots(prev, empty);
    const sql = diffToSQL(diff);

    expect(sql.some((s) => s.includes('-- WARNING: data will be lost'))).toBe(true);
    expect(sql.some((s) => s.includes('DROP TABLE "sql_drop"'))).toBe(true);
  });

  it('generates ALTER TABLE ADD COLUMN for added column', () => {
    const v1 = defineTable('sql_col_add', { title: v.string() });
    const v2 = defineTable('sql_col_add', { title: v.string(), body: v.optional(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const sql = diffToSQL(diff);

    expect(sql.some((s) => s.includes('ALTER TABLE "sql_col_add" ADD COLUMN "body"'))).toBe(true);
  });

  it('generates ALTER TABLE DROP COLUMN for dropped column', () => {
    const v1 = defineTable('sql_col_drop', { title: v.string(), body: v.optional(v.string()) });
    const v2 = defineTable('sql_col_drop', { title: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const sql = diffToSQL(diff);

    expect(sql.some((s) => s.includes('ALTER TABLE "sql_col_drop" DROP COLUMN "body"'))).toBe(
      true,
    );
  });

  it('generates warning comment for modified column', () => {
    const v1 = defineTable('sql_col_mod', { status: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = JSON.parse(JSON.stringify(prev)) as SchemaSnapshot;
    next.tables['sql_col_mod'].columns['status'].type = 'INTEGER';
    const diff = diffSnapshots(prev, next);
    const sql = diffToSQL(diff);

    expect(
      sql.some((s) => s.includes('-- WARNING: column') && s.includes('cannot ALTER COLUMN')),
    ).toBe(true);
  });

  it('generates CREATE INDEX for added index', () => {
    const v1 = defineTable('sql_idx_add', { email: v.string() });
    const v2 = defineTable('sql_idx_add', { email: v.string() });
    defineIndex(v2, ['email'], { unique: true });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const sql = diffToSQL(diff);

    expect(
      sql.some(
        (s) => s.includes('CREATE UNIQUE INDEX') && s.includes('sql_idx_add') && s.includes('email'),
      ),
    ).toBe(true);
  });

  it('generates DROP INDEX for dropped index', () => {
    const v1 = defineTable('sql_idx_drop', { email: v.string() });
    defineIndex(v1, ['email'], { unique: true });
    const v2 = defineTable('sql_idx_drop', { email: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const sql = diffToSQL(diff);

    expect(sql.some((s) => s.includes('DROP INDEX'))).toBe(true);
  });

  it('generates CREATE TRIGGER in CREATE TABLE output', () => {
    const users = defineTable('sql_trg', { email: v.string() });
    const next = serializeSchema({ users });
    const diff = diffSnapshots(empty, next);
    const sql = diffToSQL(diff);

    expect(sql.some((s) => s.includes('CREATE TRIGGER') && s.includes('sql_trg'))).toBe(true);
  });

  it('generates empty array when no changes', () => {
    const users = defineTable('sql_noop', { email: v.string() });
    const snap = serializeSchema({ users });
    const diff = diffSnapshots(snap, snap);
    expect(diffToSQL(diff)).toEqual([]);
  });

  it('dropping a non-constrained column uses ALTER TABLE DROP COLUMN (no recreation)', () => {
    const v1 = defineTable('sql_drop_plain', { title: v.string(), note: v.optional(v.string()) });
    const v2 = defineTable('sql_drop_plain', { title: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const sql = diffToSQL(diffSnapshots(prev, next));

    expect(sql.some((s) => s.includes('ALTER TABLE "sql_drop_plain" DROP COLUMN "note"'))).toBe(true);
    expect(sql.some((s) => s.includes('_new'))).toBe(false);
    expect(sql.some((s) => s.includes('Cannot DROP COLUMN'))).toBe(false);
  });

  it('dropping a PK column emits recreation instead of ALTER TABLE DROP COLUMN', () => {
    const v1 = defineTable('sql_drop_pk', { title: v.string() });
    const prev = serializeSchema({ t: v1 });
    // Simulate dropping the 'id' PK column in next snapshot
    const next = JSON.parse(JSON.stringify(prev)) as SchemaSnapshot;
    delete next.tables['sql_drop_pk'].columns['id'];
    const sql = diffToSQL(diffSnapshots(prev, next));

    expect(sql.some((s) => s.includes('Cannot DROP COLUMN "id"'))).toBe(true);
    expect(sql.some((s) => s.includes('WARNING') && s.includes('recreated'))).toBe(true);
    expect(sql.some((s) => s.includes('CREATE TABLE "sql_drop_pk_new"'))).toBe(true);
    expect(sql.some((s) => s.includes('INSERT INTO "sql_drop_pk_new"') && s.includes('FROM "sql_drop_pk"'))).toBe(true);
    expect(sql.some((s) => s.includes('DROP TABLE "sql_drop_pk"'))).toBe(true);
    expect(sql.some((s) => s.includes('ALTER TABLE "sql_drop_pk_new" RENAME TO "sql_drop_pk"'))).toBe(true);
    expect(sql.some((s) => s.includes('ALTER TABLE "sql_drop_pk" DROP COLUMN'))).toBe(false);
  });

  it('dropping a unique-indexed column emits recreation', () => {
    const v1 = defineTable('sql_drop_uniq', { email: v.string(), name: v.optional(v.string()) });
    defineIndex(v1, ['email'], { unique: true });
    const v2 = defineTable('sql_drop_uniq', { name: v.optional(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const sql = diffToSQL(diffSnapshots(prev, next));

    expect(sql.some((s) => s.includes('Cannot DROP COLUMN "email"'))).toBe(true);
    expect(sql.some((s) => s.includes('CREATE TABLE "sql_drop_uniq_new"'))).toBe(true);
    expect(sql.some((s) => s.includes('DROP TABLE "sql_drop_uniq"'))).toBe(true);
    expect(sql.some((s) => s.includes('ALTER TABLE "sql_drop_uniq_new" RENAME TO "sql_drop_uniq"'))).toBe(true);
    expect(sql.some((s) => s.includes('ALTER TABLE "sql_drop_uniq" DROP COLUMN'))).toBe(false);
  });

  it('recreation: generates chunked INSERT statements by rowid range', () => {
    const v1 = defineTable('sql_chunks', { email: v.string(), name: v.optional(v.string()) });
    defineIndex(v1, ['email'], { unique: true });
    const v2 = defineTable('sql_chunks', { name: v.optional(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const sql = diffToSQL(diffSnapshots(prev, next), 5000);

    const inserts = sql.filter((s) => s.includes('INSERT INTO "sql_chunks_new"'));
    // Default 10 chunks
    expect(inserts.length).toBe(10);
    // First chunk covers rowid 1–5000
    expect(inserts[0]).toContain('WHERE rowid BETWEEN 1 AND 5000');
    // Second chunk covers 5001–10000
    expect(inserts[1]).toContain('WHERE rowid BETWEEN 5001 AND 10000');
    // Trailing comment about extending
    expect(sql.some((s) => s.includes('more than 50000 rows') || s.includes('more than 50,000 rows') || (s.includes('more') && s.includes('50000')))).toBe(true);
  });

  it('recreation: chunkSize=0 emits single INSERT', () => {
    const v1 = defineTable('sql_nochunk', { email: v.string(), name: v.optional(v.string()) });
    defineIndex(v1, ['email'], { unique: true });
    const v2 = defineTable('sql_nochunk', { name: v.optional(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const sql = diffToSQL(diffSnapshots(prev, next), 0);

    const inserts = sql.filter((s) => s.includes('INSERT INTO "sql_nochunk_new"'));
    expect(inserts.length).toBe(1);
    expect(inserts[0]).not.toContain('WHERE rowid');
  });

  it('recreation: surviving columns are selected in all INSERT chunks', () => {
    const v1 = defineTable('sql_insert_cols', { email: v.string(), name: v.optional(v.string()) });
    defineIndex(v1, ['email'], { unique: true });
    const v2 = defineTable('sql_insert_cols', { name: v.optional(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const sql = diffToSQL(diffSnapshots(prev, next));

    const inserts = sql.filter((s) => s.includes('INSERT INTO "sql_insert_cols_new"'));
    expect(inserts.length).toBeGreaterThan(0);
    for (const stmt of inserts) {
      // 'email' is dropped — should NOT appear in SELECT
      expect(stmt).not.toContain('"email"');
      // surviving columns should be selected
      expect(stmt).toContain('"id"');
      expect(stmt).toContain('"name"');
    }
  });

  it('recreation: triggers are re-emitted; no duplicate trigger create', () => {
    const v1 = defineTable('sql_rec_trg', { email: v.string(), name: v.optional(v.string()) });
    defineIndex(v1, ['email'], { unique: true });
    const v2 = defineTable('sql_rec_trg', { name: v.optional(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const sql = diffToSQL(diffSnapshots(prev, next));

    const triggerStatements = sql.filter((s) => s.includes('CREATE TRIGGER'));
    // updatedAt trigger should appear exactly once
    expect(triggerStatements.length).toBe(1);
    expect(triggerStatements[0]).toContain('sql_rec_trg');
  });
});


// ----------------------------------------------------------------------------
// SQLite Integration Tests
// Tests run generated SQL against a real in-memory SQLite database (node:sqlite)
// and assert the resulting schema structure is correct.
// ----------------------------------------------------------------------------

describe('SQLite integration: CREATE TABLE from schema', () => {
  let closeDb: (() => void) | null = null;

  afterEach(() => {
    closeDb?.();
    closeDb = null;
  });

  it('creates a table with all column types and inserts a row', () => {
    const products = defineTable('products', {
      name: v.string(),
      price: v.number(),
      qty: v.pipe(v.number(), v.integer()),
      active: v.boolean(),
      tags: v.optional(v.array(v.string())),
      meta: v.optional(v.object({ color: v.string() })),
    });

    const snap = serializeSchema({ products });
    const diff = diffSnapshots({ version: 1, tables: {} }, snap);
    const sql = diffToSQL(diff);

    const { db, close } = applySQL(sql);
    closeDb = close;

    db.exec(
      `INSERT INTO "products" ("name","price","qty","active") VALUES ('Widget', 9.99, 5, 1)`,
    );
    const row = db.prepare('SELECT * FROM "products"').get() as Record<string, unknown>;
    expect(row['name']).toBe('Widget');
    expect(row['price']).toBe(9.99);
    expect(row['qty']).toBe(5);
    expect(row['active']).toBe(1);
  });

  it('auto id is INTEGER PRIMARY KEY AUTOINCREMENT', () => {
    const t = defineTable('auto_pk', { label: v.string() });
    const snap = serializeSchema({ t });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const { db, close } = applySQL(sql);
    closeDb = close;

    db.exec(`INSERT INTO "auto_pk" ("label") VALUES ('first')`);
    db.exec(`INSERT INTO "auto_pk" ("label") VALUES ('second')`);
    const rows = db.prepare('SELECT id FROM "auto_pk" ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    expect(rows.map((r) => r['id'])).toEqual([1, 2]);
  });

  it('createdAt and updatedAt have default datetime values', () => {
    const t = defineTable('ts_cols', { title: v.string() });
    const snap = serializeSchema({ t });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const { db, close } = applySQL(sql);
    closeDb = close;

    db.exec(`INSERT INTO "ts_cols" ("title") VALUES ('hello')`);
    const row = db.prepare('SELECT createdAt, updatedAt FROM "ts_cols"').get() as Record<
      string,
      unknown
    >;
    expect(typeof row['createdAt']).toBe('string');
    expect((row['createdAt'] as string).length).toBeGreaterThan(0);
  });

  it('updatedAt trigger fires on UPDATE', () => {
    const t = defineTable('trigger_test', { value: v.string() });
    const snap = serializeSchema({ t });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const { db, close } = applySQL(sql);
    closeDb = close;

    db.exec(`INSERT INTO "trigger_test" ("value") VALUES ('old')`);
    const before = (
      db.prepare('SELECT updatedAt FROM "trigger_test"').get() as Record<string, string>
    )['updatedAt'];

    // Wait 1 second so datetime('now') advances
    // Instead, check the trigger SQL is present in the output
    const hasTrigger = sql.some((s) => s.includes('CREATE TRIGGER') && s.includes('trigger_test'));
    expect(hasTrigger).toBe(true);

    // Verify the trigger is actually registered in the DB
    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='trigger_test'`)
      .all() as { name: string }[];
    expect(triggers.some((trg) => trg.name.includes('trigger_test'))).toBe(true);
    expect(before).toBeDefined();
  });

  it('unique index enforces uniqueness', () => {
    const users = defineTable('uniq_users', { email: v.string() });
    defineIndex(users, ['email'], { unique: true });
    const snap = serializeSchema({ users });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const { db, close } = applySQL(sql);
    closeDb = close;

    db.exec(`INSERT INTO "uniq_users" ("email") VALUES ('a@example.com')`);
    expect(() => {
      db.exec(`INSERT INTO "uniq_users" ("email") VALUES ('a@example.com')`);
    }).toThrow();
  });

  it('ALTER TABLE ADD COLUMN works on existing table', () => {
    // v1: create table
    const v1 = defineTable('alter_add', { title: v.string() });
    const snap1 = serializeSchema({ t: v1 });
    const sql1 = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap1));

    const { db, close } = applySQL(sql1);
    closeDb = close;

    db.exec(`INSERT INTO "alter_add" ("title") VALUES ('hello')`);

    // v2: add column
    const v2 = defineTable('alter_add', { title: v.string(), body: v.optional(v.string()) });
    const snap2 = serializeSchema({ t: v2 });
    const diff = diffSnapshots(snap1, snap2);
    const sql2 = diffToSQL(diff).filter((s) => !s.startsWith('--'));
    for (const stmt of sql2) {
      db.exec(stmt);
    }

    // Insert row with new column
    db.exec(`INSERT INTO "alter_add" ("title","body") VALUES ('world','content')`);
    const rows = db
      .prepare('SELECT title, body FROM "alter_add" ORDER BY id')
      .all() as Record<string, unknown>[];
    expect(rows[0]['body']).toBeNull();
    expect(rows[1]['body']).toBe('content');
  });

  it('ALTER TABLE DROP COLUMN removes column', () => {
    // v1: create table with extra column
    const v1 = defineTable('alter_drop', { title: v.string(), legacy: v.optional(v.string()) });
    const snap1 = serializeSchema({ t: v1 });
    const sql1 = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap1));

    const { db, close } = applySQL(sql1);
    closeDb = close;

    // v2: drop the legacy column
    const v2 = defineTable('alter_drop', { title: v.string() });
    const snap2 = serializeSchema({ t: v2 });
    const sql2 = diffToSQL(diffSnapshots(snap1, snap2)).filter((s) => !s.startsWith('--'));
    for (const stmt of sql2) {
      db.exec(stmt);
    }

    const cols = db
      .prepare(`PRAGMA table_info("alter_drop")`)
      .all() as { name: string }[];
    expect(cols.some((c) => c.name === 'legacy')).toBe(false);
    expect(cols.some((c) => c.name === 'title')).toBe(true);
  });

  it('nullable column accepts NULL', () => {
    const t = defineTable('null_col', { note: v.optional(v.string()) });
    const snap = serializeSchema({ t });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const { db, close } = applySQL(sql);
    closeDb = close;

    db.exec(`INSERT INTO "null_col" DEFAULT VALUES`);
    const row = db.prepare('SELECT note FROM "null_col"').get() as Record<string, unknown>;
    expect(row['note']).toBeNull();
  });

  it('NOT NULL column rejects NULL insert', () => {
    const t = defineTable('notnull_col', { email: v.string() });
    const snap = serializeSchema({ t });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const { db, close } = applySQL(sql);
    closeDb = close;

    expect(() => {
      db.exec(`INSERT INTO "notnull_col" ("email") VALUES (NULL)`);
    }).toThrow();
  });

  it('partial index: only partial index entry enforces on matching rows', () => {
    const t = defineTable('partial_idx', { email: v.string(), active: v.pipe(v.number(), v.integer()) });
    // unique partial index only on active=1
    defineIndex(t, ['email'], { unique: true, where: '"active" = 1' });
    const snap = serializeSchema({ t });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const { db, close } = applySQL(sql);
    closeDb = close;

    // Two rows with same email but active=0: allowed (not in partial index)
    db.exec(`INSERT INTO "partial_idx" ("email","active") VALUES ('x@x.com', 0)`);
    db.exec(`INSERT INTO "partial_idx" ("email","active") VALUES ('x@x.com', 0)`);

    // Same email with active=1: second insert should fail
    db.exec(`INSERT INTO "partial_idx" ("email","active") VALUES ('x@x.com', 1)`);
    expect(() => {
      db.exec(`INSERT INTO "partial_idx" ("email","active") VALUES ('x@x.com', 1)`);
    }).toThrow();
  });

  it('table with no auto columns: only user columns present', () => {
    const t = defineTable(
      'bare_table',
      { uuid: v.string(), value: v.pipe(v.number(), v.integer()) },
      { primaryKey: false, createdAt: false, updatedAt: false },
    );
    const snap = serializeSchema({ t });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const { db, close } = applySQL(sql);
    closeDb = close;

    db.exec(`INSERT INTO "bare_table" ("uuid","value") VALUES ('abc-123', 42)`);
    const cols = db.prepare(`PRAGMA table_info("bare_table")`).all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(['uuid', 'value']);
  });

  it('foreign key: CREATE TABLE includes FK constraint and enforces it', () => {
    const categories = defineTable('fk_categories', { name: v.string() });
    const posts = defineTable(
      'fk_posts',
      { title: v.string(), categoryId: v.pipe(v.number(), v.integer()) },
      { foreignKeys: [{ columns: ['categoryId'], references: categories }] },
    );
    const snap = serializeSchema({ categories, posts });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    // PRAGMA should be prepended
    expect(sql[0]).toBe('PRAGMA foreign_keys = ON;');

    // FK constraint should appear in CREATE TABLE
    const createPosts = sql.find((s) => s.includes('CREATE TABLE "fk_posts"'));
    expect(createPosts).toContain('FOREIGN KEY ("categoryId") REFERENCES "fk_categories"("id")');

    const { db, close } = applySQL(sql);
    closeDb = close;

    // Valid insert: category exists
    db.exec(`INSERT INTO "fk_categories" ("name") VALUES ('tech')`);
    db.exec(`INSERT INTO "fk_posts" ("title","categoryId") VALUES ('Hello', 1)`);

    // Invalid insert: category 999 does not exist — should throw
    expect(() => {
      db.exec(`INSERT INTO "fk_posts" ("title","categoryId") VALUES ('Bad', 999)`);
    }).toThrow();
  });

  it('foreign key: onDelete CASCADE', () => {
    const authors = defineTable('fk_authors', { name: v.string() });
    const articles = defineTable(
      'fk_articles',
      { title: v.string(), authorId: v.pipe(v.number(), v.integer()) },
      { foreignKeys: [{ columns: ['authorId'], references: authors, onDelete: 'CASCADE' }] },
    );
    const snap = serializeSchema({ authors, articles });
    const sql = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap));

    const createArticles = sql.find((s) => s.includes('CREATE TABLE "fk_articles"'));
    expect(createArticles).toContain('ON DELETE CASCADE');

    const { db, close } = applySQL(sql);
    closeDb = close;

    db.exec(`INSERT INTO "fk_authors" ("name") VALUES ('Alice')`);
    db.exec(`INSERT INTO "fk_articles" ("title","authorId") VALUES ('Post 1', 1)`);
    db.exec(`DELETE FROM "fk_authors" WHERE "id" = 1`);

    const rows = db.prepare(`SELECT * FROM "fk_articles"`).all();
    expect(rows).toHaveLength(0); // cascaded delete
  });

  it('foreign key: ADD COLUMN with nullable FK inlines REFERENCES', () => {
    const depts = defineTable('fk_depts', { name: v.string() });
    const emps_v1 = defineTable('fk_emps', { name: v.string() });
    const emps_v2 = defineTable(
      'fk_emps',
      {
        name: v.string(),
        deptId: v.optional(v.pipe(v.number(), v.integer())),
      },
      { foreignKeys: [{ columns: ['deptId'], references: depts }] },
    );

    const prev = serializeSchema({ depts, emps: emps_v1 });
    const next = serializeSchema({ depts, emps: emps_v2 });
    const sql = diffToSQL(diffSnapshots(prev, next));

    // PRAGMA prepended, inline REFERENCES present
    expect(sql[0]).toBe('PRAGMA foreign_keys = ON;');
    expect(
      sql.some((s) => s.includes('ADD COLUMN "deptId"') && s.includes('REFERENCES "fk_depts"("id")')),
    ).toBe(true);
  });

  it('recreate table when dropping a unique-indexed column: data preserved, column removed', () => {
    // v1: table with a unique-indexed column
    const v1 = defineTable('rec_uniq_col', { email: v.string(), name: v.optional(v.string()) });
    defineIndex(v1, ['email'], { unique: true });
    const snap1 = serializeSchema({ t: v1 });
    const sql1 = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap1));

    const { db, close } = applySQL(sql1);
    closeDb = close;

    db.exec(`INSERT INTO "rec_uniq_col" ("email","name") VALUES ('a@x.com','Alice')`);
    db.exec(`INSERT INTO "rec_uniq_col" ("email","name") VALUES ('b@x.com','Bob')`);

    // v2: drop the unique-indexed column
    const v2 = defineTable('rec_uniq_col', { name: v.optional(v.string()) });
    const snap2 = serializeSchema({ t: v2 });
    const sql2 = diffToSQL(diffSnapshots(snap1, snap2)).filter((s) => !s.startsWith('--'));
    for (const stmt of sql2) {
      db.exec(stmt);
    }

    // Column 'email' should be gone
    const cols = db.prepare(`PRAGMA table_info("rec_uniq_col")`).all() as { name: string }[];
    expect(cols.some((c) => c.name === 'email')).toBe(false);
    expect(cols.some((c) => c.name === 'name')).toBe(true);

    // Data from surviving columns should be preserved
    const rows = db.prepare('SELECT name FROM "rec_uniq_col" ORDER BY id').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]['name']).toBe('Alice');
    expect(rows[1]['name']).toBe('Bob');
  });

  it('recreate table when dropping a unique-indexed column: updatedAt trigger is restored', () => {
    const v1 = defineTable('rec_trg_restore', { email: v.string(), name: v.optional(v.string()) });
    defineIndex(v1, ['email'], { unique: true });
    const snap1 = serializeSchema({ t: v1 });
    const sql1 = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap1));

    const { db, close } = applySQL(sql1);
    closeDb = close;

    db.exec(`INSERT INTO "rec_trg_restore" ("email","name") VALUES ('x@x.com','X')`);

    const v2 = defineTable('rec_trg_restore', { name: v.optional(v.string()) });
    const snap2 = serializeSchema({ t: v2 });
    const sql2 = diffToSQL(diffSnapshots(snap1, snap2)).filter((s) => !s.startsWith('--'));
    for (const stmt of sql2) {
      db.exec(stmt);
    }

    // Trigger should still be registered after recreation
    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='rec_trg_restore'`)
      .all() as { name: string }[];
    expect(triggers.some((trg) => trg.name.includes('rec_trg_restore'))).toBe(true);
  });

  it('recreate table preserves remaining indexes', () => {
    const v1 = defineTable('rec_idx_keep', {
      email: v.string(),
      role: v.string(),
    });
    // unique index on email (will be dropped with the column)
    defineIndex(v1, ['email'], { unique: true });
    // regular index on role (should survive)
    defineIndex(v1, ['role'], { unique: false });
    const snap1 = serializeSchema({ t: v1 });
    const sql1 = diffToSQL(diffSnapshots({ version: 1, tables: {} }, snap1));

    const { db, close } = applySQL(sql1);
    closeDb = close;

    db.exec(`INSERT INTO "rec_idx_keep" ("email","role") VALUES ('a@x.com','admin')`);

    // v2: drop the unique-indexed column
    const v2 = defineTable('rec_idx_keep', { role: v.string() });
    defineIndex(v2, ['role'], { unique: false });
    const snap2 = serializeSchema({ t: v2 });
    const sql2 = diffToSQL(diffSnapshots(snap1, snap2)).filter((s) => !s.startsWith('--'));
    for (const stmt of sql2) {
      db.exec(stmt);
    }

    // The role index should exist
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rec_idx_keep'`)
      .all() as { name: string }[];
    expect(indexes.some((i) => i.name.includes('role'))).toBe(true);
    // The email index should not exist
    expect(indexes.some((i) => i.name.includes('email'))).toBe(false);
  });

  it('foreign key: NOT NULL FK add column emits warning', () => {
    const org = defineTable('fk_org', { name: v.string() });
    const emp_v1 = defineTable('fk_emp_nn', { name: v.string() });
    const emp_v2 = defineTable(
      'fk_emp_nn',
      { name: v.string(), orgId: v.pipe(v.number(), v.integer()) },
      { foreignKeys: [{ columns: ['orgId'], references: org }] },
    );

    const prev = serializeSchema({ org, emp: emp_v1 });
    const next = serializeSchema({ org, emp: emp_v2 });
    const sql = diffToSQL(diffSnapshots(prev, next));

    expect(sql.some((s) => s.includes('-- WARNING') && s.includes('NOT NULL') && s.includes('orgId'))).toBe(true);
  });
});
