import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { defineTable, defineIndex, defineTrigger } from './schema.js';
import { serializeSchema, EMPTY_SNAPSHOT } from './snapshot.js';
import type { ColumnSnapshot, SchemaSnapshot, TableSnapshot } from './snapshot.js';
import { diffSnapshots, applyRenames } from './diff.js';
import type { Rename } from './diff.js';
import { diffToSQL } from './sql.js';

function table(name: string, columns: ColumnSnapshot[], extra: Partial<TableSnapshot> = {}): TableSnapshot {
  return {
    name,
    columns: Object.fromEntries(columns.map((c) => [c.name, c])),
    indexes: {},
    triggers: {},
    foreignKeys: {},
    ...extra,
  };
}

function snap(...tables: TableSnapshot[]): SchemaSnapshot {
  return { ...EMPTY_SNAPSHOT, tables: Object.fromEntries(tables.map((t) => [t.name, t])) };
}

const col = (name: string, over: Partial<ColumnSnapshot> = {}): ColumnSnapshot => ({
  name,
  type: 'text',
  notNull: true,
  ...over,
});

const idCol = col('id', { type: 'bigint', primaryKey: true, identity: true });

function run(prev: SchemaSnapshot, next: SchemaSnapshot, renames: Rename[] = []): string[] {
  return diffToSQL(diffSnapshots(applyRenames(prev, renames), next), renames);
}

describe('renames', () => {
  it('writes a table rename', () => {
    const prev = snap(table('Old', [idCol]));
    const next = snap(table('New', [idCol]));
    expect(run(prev, next, [{ kind: 'table', from: 'Old', to: 'New' }])).toEqual([
      'ALTER TABLE "Old" RENAME TO "New";',
    ]);
  });

  it('writes a column rename', () => {
    const prev = snap(table('User', [idCol, col('name')]));
    const next = snap(table('User', [idCol, col('fullName')]));
    expect(run(prev, next, [{ kind: 'column', table: 'User', from: 'name', to: 'fullName' }])).toEqual([
      'ALTER TABLE "User" RENAME COLUMN "name" TO "fullName";',
    ]);
  });
});

describe('new tables', () => {
  it('writes columns, then indexes', () => {
    const next = snap(
      table('User', [idCol, col('email'), col('bio', { notNull: false }), col('createdAt', { type: 'timestamptz', default: 'now()' })], {
        indexes: {
          User_email_uq: { name: 'User_email_uq', columns: ['email'], unique: true },
          User_bio_idx: { name: 'User_bio_idx', columns: ['bio'], unique: false, where: '"bio" IS NOT NULL' },
        },
      }),
    );
    expect(run(EMPTY_SNAPSHOT, next)).toEqual([
      [
        'CREATE TABLE "User" (',
        '  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,',
        '  "email" text NOT NULL,',
        '  "bio" text,',
        '  "createdAt" timestamptz NOT NULL DEFAULT now()',
        ');',
      ].join('\n'),
      'CREATE UNIQUE INDEX "User_email_uq" ON "User" ("email");',
      'CREATE INDEX "User_bio_idx" ON "User" ("bio") WHERE "bio" IS NOT NULL;',
    ]);
  });

  it('writes a uuid id', () => {
    const id = col('id', { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' });
    const out = run(EMPTY_SNAPSHOT, snap(table('Tag', [id])));
    expect(out[0]).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()');
  });

  it('creates tables before their foreign keys', () => {
    const User = defineTable('User', { email: v.string() });
    const Post = defineTable('Post', { authorId: v.bigint() }, { foreignKeys: [{ columns: ['authorId'], references: User }] });
    const out = diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, serializeSchema({ Post, User })));
    const fk = out.findIndex((s) => s.includes('ADD CONSTRAINT "Post_authorId_fkey"'));
    expect(fk).toBeGreaterThan(-1);
    expect(out.findIndex((s) => s.startsWith('CREATE TABLE "User"'))).toBeLessThan(fk);
    expect(out.findIndex((s) => s.startsWith('CREATE TABLE "Post"'))).toBeLessThan(fk);
  });

  it('writes the foreign key with actions', () => {
    const next = snap(
      table('Post', [idCol, col('authorId', { type: 'bigint' })], {
        foreignKeys: {
          authorId: { name: 'Post_authorId_fkey', columns: ['authorId'], refTable: 'User', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'RESTRICT' },
        },
      }),
    );
    expect(run(EMPTY_SNAPSHOT, next)[1]).toBe(
      'ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;',
    );
  });

  it('writes a foreign key without actions and with two columns', () => {
    const next = snap(
      table('Line', [col('a'), col('b')], {
        foreignKeys: { 'a,b': { name: 'Line_a_b_fkey', columns: ['a', 'b'], refTable: 'Pair', refColumns: ['x', 'y'] } },
      }),
    );
    expect(run(EMPTY_SNAPSHOT, next)[1]).toBe(
      'ALTER TABLE "Line" ADD CONSTRAINT "Line_a_b_fkey" FOREIGN KEY ("a", "b") REFERENCES "Pair"("x", "y");',
    );
  });
});

describe('triggers', () => {
  const trg = { name: 'User_audit', timing: 'AFTER', event: 'INSERT', tableName: 'User', body: 'PERFORM 1;' };

  it('writes a function and a trigger', () => {
    const next = snap(table('User', [idCol], { triggers: { User_audit: trg } }));
    expect(run(EMPTY_SNAPSHOT, next).slice(1)).toEqual([
      'CREATE OR REPLACE FUNCTION "User_audit_fn"() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\n  RETURN NEW;\nEND $$;',
      'CREATE TRIGGER "User_audit" AFTER INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION "User_audit_fn"();',
    ]);
  });

  it('returns OLD from DELETE triggers', () => {
    const User = defineTable('User', { email: v.string() });
    defineTrigger('User_gone', { timing: 'AFTER', event: 'DELETE', on: User, body: 'PERFORM 1;' });
    const out = diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, serializeSchema({ User })));
    expect(out.join('\n')).toContain('RETURN OLD;');
  });

  it('writes the updatedAt trigger for a default table', () => {
    const User = defineTable('User', { email: v.string() });
    const out = diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, serializeSchema({ User })));
    expect(out.join('\n')).toContain('NEW."updatedAt" = now();');
    expect(out.join('\n')).toContain('CREATE TRIGGER "User_updatedAt_trg" BEFORE UPDATE ON "User"');
  });

  it('drops a trigger and its function', () => {
    const prev = snap(table('User', [idCol], { triggers: { User_audit: trg } }));
    const next = snap(table('User', [idCol]));
    expect(run(prev, next)).toEqual([
      'DROP TRIGGER IF EXISTS "User_audit" ON "User";',
      'DROP FUNCTION IF EXISTS "User_audit_fn"();',
    ]);
  });

  it('drops then creates a changed trigger', () => {
    const prev = snap(table('User', [idCol], { triggers: { User_audit: trg } }));
    const next = snap(table('User', [idCol], { triggers: { User_audit: { ...trg, body: 'PERFORM 2;' } } }));
    const out = run(prev, next);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe('DROP TRIGGER IF EXISTS "User_audit" ON "User";');
    expect(out[1]).toBe('DROP FUNCTION IF EXISTS "User_audit_fn"();');
    expect(out[2]).toContain('PERFORM 2;');
    expect(out[3]).toContain('CREATE TRIGGER "User_audit"');
  });
});

describe('indexes and foreign keys on changed tables', () => {
  const idx = { name: 'User_email_idx', columns: ['email'], unique: false };

  it('drops an index', () => {
    const prev = snap(table('User', [idCol, col('email')], { indexes: { User_email_idx: idx } }));
    const next = snap(table('User', [idCol, col('email')]));
    expect(run(prev, next)).toEqual(['DROP INDEX IF EXISTS "User_email_idx";']);
  });

  it('drops then creates a changed index', () => {
    const prev = snap(table('User', [idCol, col('email')], { indexes: { User_email_idx: idx } }));
    const next = snap(table('User', [idCol, col('email')], { indexes: { User_email_idx: { ...idx, unique: true } } }));
    expect(run(prev, next)).toEqual([
      'DROP INDEX IF EXISTS "User_email_idx";',
      'CREATE UNIQUE INDEX "User_email_idx" ON "User" ("email");',
    ]);
  });

  it('drops a foreign key before index changes and adds one after', () => {
    const fk = { name: 'Post_authorId_fkey', columns: ['authorId'], refTable: 'User', refColumns: ['id'] };
    const cols = [idCol, col('authorId', { type: 'bigint' })];
    const prev = snap(table('Post', cols, { foreignKeys: { authorId: fk } }));
    const next = snap(table('Post', cols, { foreignKeys: { authorId: { ...fk, onDelete: 'CASCADE' } } }));
    expect(run(prev, next)).toEqual([
      'ALTER TABLE "Post" DROP CONSTRAINT "Post_authorId_fkey";',
      'ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE;',
    ]);
  });
});

describe('foreign key names', () => {
  const cols = [idCol, col('authorId', { type: 'bigint' })];
  const fk = { name: 'Old_authorId_fkey', columns: ['authorId'], refTable: 'User', refColumns: ['id'] };

  it('writes only RENAME CONSTRAINT when the name alone changes', () => {
    const prev = snap(table('Post', cols, { foreignKeys: { authorId: fk } }));
    const next = snap(table('Post', cols, { foreignKeys: { authorId: { ...fk, name: 'Post_authorId_fkey' } } }));
    expect(run(prev, next)).toEqual([
      'ALTER TABLE "Post" RENAME CONSTRAINT "Old_authorId_fkey" TO "Post_authorId_fkey";',
    ]);
  });

  it('drops a foreign key by its stored name', () => {
    const prev = snap(table('Post', cols, { foreignKeys: { authorId: fk } }));
    expect(run(prev, snap(table('Post', cols)))).toEqual([
      'ALTER TABLE "Post" DROP CONSTRAINT "Old_authorId_fkey";',
    ]);
  });

  it('drops a foreign key before dropping its column', () => {
    const prev = snap(table('Post', cols, { foreignKeys: { authorId: fk } }));
    const out = run(prev, snap(table('Post', [idCol])));
    expect(out[0]).toBe('ALTER TABLE "Post" DROP CONSTRAINT "Old_authorId_fkey";');
    expect(out[out.length - 1]).toBe('ALTER TABLE "Post" DROP COLUMN "authorId";');
  });
});

describe('column changes', () => {
  const base = (c: ColumnSnapshot) => snap(table('User', [idCol, c]));

  it('adds a nullable column', () => {
    expect(run(base(col('a')), snap(table('User', [idCol, col('a'), col('b', { notNull: false })])))).toEqual([
      'ALTER TABLE "User" ADD COLUMN "b" text;',
    ]);
  });

  it('warns when adding NOT NULL with no default', () => {
    const out = run(base(col('a')), snap(table('User', [idCol, col('a'), col('b')])));
    expect(out).toEqual([
      '-- WARNING: adds NOT NULL column "User"."b" with no default. This fails if the table has rows. Add a default, or add the column as nullable and fill it first.',
      'ALTER TABLE "User" ADD COLUMN "b" text NOT NULL;',
    ]);
  });

  it('does not warn when adding NOT NULL with a default', () => {
    const out = run(base(col('a')), snap(table('User', [idCol, col('a'), col('b', { default: "'x'" })])));
    expect(out).toEqual([`ALTER TABLE "User" ADD COLUMN "b" text NOT NULL DEFAULT 'x';`]);
  });

  it('warns on drop column', () => {
    const out = run(base(col('a')), snap(table('User', [idCol])));
    expect(out).toEqual([
      '-- WARNING: drops column "User"."a" and its data. If this is a rename, run schema:diff again and answer yes.',
      'ALTER TABLE "User" DROP COLUMN "a";',
    ]);
  });

  it('writes a type change with a warning', () => {
    const out = run(base(col('a')), base(col('a', { type: 'integer' })));
    expect(out).toEqual([
      '-- WARNING: changes "User"."a" from text to integer. This fails if any row cannot be cast. Change the USING part if needed.',
      'ALTER TABLE "User" ALTER COLUMN "a" TYPE integer USING "a"::integer;',
    ]);
  });

  it('writes SET NOT NULL with a warning', () => {
    const out = run(base(col('a', { notNull: false })), base(col('a')));
    expect(out).toEqual([
      '-- WARNING: makes "User"."a" NOT NULL. This fails if any row holds NULL. Fill those rows first.',
      'ALTER TABLE "User" ALTER COLUMN "a" SET NOT NULL;',
    ]);
  });

  it('writes DROP NOT NULL without a warning', () => {
    expect(run(base(col('a')), base(col('a', { notNull: false })))).toEqual([
      'ALTER TABLE "User" ALTER COLUMN "a" DROP NOT NULL;',
    ]);
  });

  it('writes SET DEFAULT and DROP DEFAULT', () => {
    expect(run(base(col('a')), base(col('a', { default: "'x'" })))).toEqual([
      `ALTER TABLE "User" ALTER COLUMN "a" SET DEFAULT 'x';`,
    ]);
    expect(run(base(col('a', { default: "'x'" })), base(col('a')))).toEqual([
      'ALTER TABLE "User" ALTER COLUMN "a" DROP DEFAULT;',
    ]);
  });

  it('writes one statement per changed part', () => {
    const out = run(base(col('a', { notNull: false })), base(col('a', { type: 'integer', default: '0' })));
    expect(out.filter((s) => !s.startsWith('--'))).toEqual([
      'ALTER TABLE "User" ALTER COLUMN "a" TYPE integer USING "a"::integer;',
      'ALTER TABLE "User" ALTER COLUMN "a" SET NOT NULL;',
      'ALTER TABLE "User" ALTER COLUMN "a" SET DEFAULT 0;',
    ]);
  });

  it('writes only a warning when the primary key changes', () => {
    const out = run(base(col('a')), base(col('a', { primaryKey: true })));
    expect(out).toEqual([
      '-- WARNING: the primary key of "User" changed. kyt-pg does not write this change. Write it by hand.',
    ]);
  });

  it('writes only a warning when identity changes', () => {
    const prev = snap(table('User', [col('id', { type: 'bigint', primaryKey: true })]));
    const next = snap(table('User', [idCol]));
    expect(run(prev, next)).toEqual([
      '-- WARNING: the primary key of "User" changed. kyt-pg does not write this change. Write it by hand.',
    ]);
  });
});

describe('dropped tables', () => {
  it('warns once per table and writes one DROP TABLE last', () => {
    const prev = snap(table('A', [idCol]), table('B', [idCol]), table('C', [idCol, col('x')]));
    const next = snap(table('C', [idCol, col('x'), col('y', { notNull: false })]));
    expect(run(prev, next)).toEqual([
      'ALTER TABLE "C" ADD COLUMN "y" text;',
      '-- WARNING: drops table "A" and all its rows. Keep this only if the data is not needed.',
      '-- WARNING: drops table "B" and all its rows. Keep this only if the data is not needed.',
      'DROP TABLE "A", "B";',
    ]);
  });
});

describe('output', () => {
  it('writes no BEGIN or COMMIT', () => {
    const Tag = defineTable('Tag', { label: v.string() });
    defineIndex(Tag, ['label'], { unique: true });
    const out = diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, serializeSchema({ Tag })));
    expect(out.join('\n')).not.toMatch(/^(BEGIN|COMMIT);/m);
  });

  it('writes nothing for an empty diff', () => {
    expect(diffToSQL(diffSnapshots(EMPTY_SNAPSHOT, EMPTY_SNAPSHOT))).toEqual([]);
  });
});
