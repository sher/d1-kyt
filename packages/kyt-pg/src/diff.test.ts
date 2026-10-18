import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { defineTable, defineIndex } from './schema.js';
import { serializeSchema, EMPTY_SNAPSHOT } from './snapshot.js';
import type { PgType } from './schema.js';
import type { SchemaSnapshot, TableSnapshot } from './snapshot.js';
import { diffSnapshots, findRenameCandidates, applyRenames } from './diff.js';

function snap(tables: Record<string, Record<string, PgType>>): SchemaSnapshot {
  const out: Record<string, TableSnapshot> = {};
  for (const [name, cols] of Object.entries(tables)) {
    out[name] = {
      name,
      columns: Object.fromEntries(
        Object.entries(cols).map(([c, type]) => [c, { name: c, type, notNull: true }]),
      ),
      indexes: {},
      triggers: {},
      foreignKeys: {},
    };
  }
  return { version: 1, dialect: 'postgres', tables: out };
}

describe('diffSnapshots', () => {
  const empty = EMPTY_SNAPSHOT;

  it('detects added table', () => {
    const users = defineTable('Account', { email: v.string() });
    const next = serializeSchema({ users });
    const diff = diffSnapshots(empty, next);
    expect(diff.addedTables).toHaveLength(1);
    expect(diff.addedTables[0].name).toBe('Account');
    expect(diff.droppedTables).toHaveLength(0);
    expect(diff.changedTables).toHaveLength(0);
  });

  it('detects dropped table', () => {
    const users = defineTable('Invoice', { email: v.string() });
    const prev = serializeSchema({ users });
    const diff = diffSnapshots(prev, empty);
    expect(diff.droppedTables).toHaveLength(1);
    expect(diff.droppedTables[0].name).toBe('Invoice');
    expect(diff.addedTables).toHaveLength(0);
  });

  it('detects no changes when snapshot is identical', () => {
    const users = defineTable('Profile', { email: v.string() });
    const snap = serializeSchema({ users });
    const diff = diffSnapshots(snap, snap);
    expect(diff.addedTables).toHaveLength(0);
    expect(diff.droppedTables).toHaveLength(0);
    expect(diff.changedTables).toHaveLength(0);
  });

  it('detects added column', () => {
    const v1 = defineTable('Article', { title: v.string() });
    const v2 = defineTable('Article', { title: v.string(), body: v.nullable(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const added = diff.changedTables[0]?.columns.filter((c) => !c.before && c.after);
    expect(added?.some((c) => c.name === 'body')).toBe(true);
  });

  it('detects dropped column', () => {
    const v1 = defineTable('Comment', { title: v.string(), body: v.nullable(v.string()) });
    const v2 = defineTable('Comment', { title: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const dropped = diff.changedTables[0]?.columns.filter((c) => c.before && !c.after);
    expect(dropped?.some((c) => c.name === 'body')).toBe(true);
  });

  it('detects modified column (type change)', () => {
    const v1 = defineTable('Order', { status: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = JSON.parse(JSON.stringify(prev)) as SchemaSnapshot;
    next.tables['Order'].columns['status'].type = 'integer';
    const diff = diffSnapshots(prev, next);
    const modified = diff.changedTables[0]?.columns.filter((c) => c.before && c.after);
    expect(modified?.some((c) => c.name === 'status')).toBe(true);
  });

  it('detects added index', () => {
    const v1 = defineTable('Member', { email: v.string() });
    const v2 = defineTable('Member', { email: v.string() });
    defineIndex(v2, ['email'], { unique: true });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const added = diff.changedTables[0]?.indexes.filter((i) => !i.before && i.after);
    expect(added?.length).toBeGreaterThan(0);
  });

  it('detects dropped index', () => {
    const v1 = defineTable('Device', { email: v.string() });
    defineIndex(v1, ['email'], { unique: true });
    const v2 = defineTable('Device', { email: v.string() });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const dropped = diff.changedTables[0]?.indexes.filter((i) => i.before && !i.after);
    expect(dropped?.length).toBeGreaterThan(0);
  });

  it('includes prevTable and nextTable on changed tables', () => {
    const v1 = defineTable('Review', { title: v.string() });
    const v2 = defineTable('Review', { title: v.string(), body: v.nullable(v.string()) });
    const prev = serializeSchema({ t: v1 });
    const next = serializeSchema({ t: v2 });
    const diff = diffSnapshots(prev, next);
    const changed = diff.changedTables[0];
    expect(changed?.prevTable).toBeDefined();
    expect(changed?.nextTable).toBeDefined();
    expect(changed?.prevTable.name).toBe('Review');
    expect(changed?.nextTable.columns['body']).toBeDefined();
  });
});

describe('renames', () => {
  it('offers a dropped and an added column as a rename', () => {
    const prev = snap({ User: { name: 'text' } });
    const next = snap({ User: { fullName: 'text' } });
    expect(findRenameCandidates(diffSnapshots(prev, next))).toEqual([
      { kind: 'column', table: 'User', from: 'name', to: 'fullName' },
    ]);
  });

  it('offers a dropped and an added table as a rename', () => {
    expect(findRenameCandidates(diffSnapshots(snap({ Person: {} }), snap({ User: {} })))).toEqual([
      { kind: 'table', from: 'Person', to: 'User' },
    ]);
  });

  it('leaves no column change after a column rename', () => {
    const prev = snap({ User: { name: 'text' } });
    const next = snap({ User: { fullName: 'text' } });
    const renamed = applyRenames(prev, [{ kind: 'column', table: 'User', from: 'name', to: 'fullName' }]);
    expect(diffSnapshots(renamed, next).changedTables).toEqual([]);
  });

  it('moves foreign keys that point at a renamed table', () => {
    const prev = snap({ Person: { id: 'bigint' }, Post: { authorId: 'bigint' } });
    prev.tables.Post.foreignKeys.authorId = { name: 'Post_authorId_fkey', columns: ['authorId'], refTable: 'Person', refColumns: ['id'] };
    const next = snap({ User: { id: 'bigint' }, Post: { authorId: 'bigint' } });
    next.tables.Post.foreignKeys.authorId = { name: 'Post_authorId_fkey', columns: ['authorId'], refTable: 'User', refColumns: ['id'] };
    const renamed = applyRenames(prev, [{ kind: 'table', from: 'Person', to: 'User' }]);
    expect(renamed.tables.Post.foreignKeys.authorId.refTable).toBe('User');
    expect(Object.keys(renamed.tables)).toEqual(['User', 'Post']);
    expect(diffSnapshots(renamed, next)).toEqual({ addedTables: [], droppedTables: [], changedTables: [] });
  });

  it('renames the table name and trigger table names', () => {
    const prev = snap({ Person: { id: 'bigint' } });
    prev.tables.Person.triggers.t = { name: 't', timing: 'BEFORE', event: 'UPDATE', tableName: 'Person', body: 'x' };
    const renamed = applyRenames(prev, [{ kind: 'table', from: 'Person', to: 'User' }]);
    expect(renamed.tables.User.name).toBe('User');
    expect(renamed.tables.User.triggers.t.tableName).toBe('User');
  });

  it('renames a column in indexes and foreign keys, and moves the key', () => {
    const prev = snap({ User: { id: 'bigint' }, Post: { writer: 'bigint' } });
    prev.tables.Post.indexes.i = { name: 'i', columns: ['writer'], unique: false };
    prev.tables.Post.foreignKeys.writer = { name: 'Post_writer_fkey', columns: ['writer'], refTable: 'User', refColumns: ['id'] };
    const renamed = applyRenames(prev, [
      { kind: 'column', table: 'Post', from: 'writer', to: 'authorId' },
      { kind: 'column', table: 'User', from: 'id', to: 'uid' },
    ]);
    expect(renamed.tables.Post.indexes.i.columns).toEqual(['authorId']);
    expect(renamed.tables.Post.foreignKeys).toEqual({
      authorId: { name: 'Post_writer_fkey', columns: ['authorId'], refTable: 'User', refColumns: ['uid'] },
    });
    expect(Object.keys(renamed.tables.User.columns)).toEqual(['uid']);
    expect(renamed.tables.Post.foreignKeys.authorId.name).toBe('Post_writer_fkey');
  });

  it('does not change its input', () => {
    const prev = snap({ Person: { name: 'text' } });
    const copy = structuredClone(prev);
    applyRenames(prev, [
      { kind: 'column', table: 'Person', from: 'name', to: 'fullName' },
      { kind: 'table', from: 'Person', to: 'User' },
    ]);
    expect(prev).toEqual(copy);
  });
});
