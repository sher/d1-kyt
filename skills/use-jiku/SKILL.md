---
name: use-jiku
description: Use when building with jiku — the Cloudflare D1 + Kysely + Valibot toolkit. Covers schema definition, migration generation, type inference, query execution, JSON column deserialization, D1 limits, and migration gotchas like NOT NULL FK constraints and table recreation.
---

# Using jiku

## Overview

jiku connects three layers: **Valibot** (schema/validation) → **Kysely** (type-safe query builder) → **Cloudflare D1/SQLite** (executor). No code generation, no ORM runtime.

```
schema.ts  →  schema:diff  →  .sql migration  →  wrangler apply  →  typed queries
```

## 1. Define Schema

```typescript
import { defineTable, defineIndex, withDefault } from 'jiku';
import * as v from 'valibot';

export const posts = defineTable(
  'posts',
  {
    title:      v.string(),                                        // TEXT NOT NULL
    views:      v.pipe(v.number(), v.integer()),                   // INTEGER NOT NULL
    rating:     v.number(),                                        // REAL NOT NULL
    published:  withDefault(v.boolean(), false),                   // INTEGER NOT NULL DEFAULT 0
    slug:       v.nullable(v.string()),                            // TEXT NULL
    summary:    withDefault(v.string(), 'TBD'),                    // TEXT NOT NULL DEFAULT 'TBD'
    meta:       v.object({ og: v.string() }),                      // TEXT (JSON) NOT NULL
    tags:       v.array(v.string()),                               // TEXT (JSON) NOT NULL
    categoryId: v.pipe(v.number(), v.integer()),
  },
  {
    foreignKeys: [{
      columns:    ['categoryId'],
      references: categories,
      refColumns: ['id'],       // optional, defaults to referenced table's PK
      onDelete:   'CASCADE',    // CASCADE | SET NULL | RESTRICT | NO ACTION
      onUpdate:   'NO ACTION',  // same options
    }],
  }
);

// Indexes are defined separately with defineIndex (NOT inside defineTable options)
export const postsSlugIdx = defineIndex(posts, ['slug'], { unique: true });
export const postsPublishedIdx = defineIndex(posts, ['views'], { where: 'published = 1' }); // partial index
export const postsCustomIdx = defineIndex(posts, ['title'], { name: 'posts_title_search_idx' });
```

**Column type mapping:**

| Valibot | SQL | Notes |
|---------|-----|-------|
| `v.string()` | TEXT NOT NULL | |
| `v.pipe(v.number(), v.integer())` | INTEGER NOT NULL | |
| `v.number()` | REAL NOT NULL | |
| `v.boolean()` | INTEGER NOT NULL | stored as 0/1 |
| `v.object({...})` / `v.array(...)` | TEXT NOT NULL | JSON serialized |
| `v.nullable(schema)` | nullable (NULL) | select type is `T \| null` |
| `withDefault(schema, val)` | NOT NULL DEFAULT val | optional on insert, `T` on select |

Auto columns added to every table: `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `createdAt` (TEXT), `updatedAt` (TEXT).

## 2. Infer Types & Create Query Builder

```typescript
import { InferDB, createQueryBuilder, withDefault } from 'jiku';

export type DB = InferDB<{
  posts: typeof posts;
  categories: typeof categories;
}>;

// Stateless, compile-only Kysely instance — no connection held
export const db = createQueryBuilder<DB>();
```

## 3. Generate Migrations

```bash
jiku schema:diff                          # auto-name from diff
jiku schema:diff add_tags_column          # custom name
jiku schema:diff --schema src/schema.ts   # custom schema path
jiku schema:diff --dir db                 # custom directory
```

Reads: `schema.ts`, `schema.json` (snapshot). Writes: numbered `.sql` migration, updated `schema.json`, and `schema.sql` (full DDL from scratch).

**Always commit `schema.json` alongside the `.sql` file** — it is the baseline for the next diff.

## 4. Execute Queries

```typescript
import { queryAll, queryFirst, queryRun, queryBatch } from 'jiku';

// All rows — JSON and boolean columns deserialize automatically
const allPosts = await queryAll(env.DB, db.selectFrom('posts').selectAll().compile());

// First row or null
const post = await queryFirst(
  env.DB,
  db.selectFrom('posts').selectAll().where('id', '=', id).compile(),
);

// INSERT / UPDATE / DELETE
const result = await queryRun(
  env.DB,
  db.insertInto('posts').values({ title: 'Hello', views: 0, ... }).compile(),
);
console.log(result.meta.changes); // rows affected

// Atomic batch
await queryBatch(env.DB, [
  db.insertInto('posts').values({ ... }).compile(),
  db.updateTable('posts').set({ views: 1 }).where('id', '=', 1).compile(),
]);
```

JSON columns (`v.object`, `v.array`) and boolean columns (`v.boolean`) are deserialized automatically — no need to pass the table explicitly.

## 5. D1 Limits

jiku enforces these at runtime — violations throw before hitting D1:

| Limit | Value | Where enforced |
|-------|-------|----------------|
| Bound parameters per query | 100 | `queryAll/First/Run/Batch` |
| SQL statement length | 100,000 chars | `queryAll/First/Run/Batch` |
| Columns per table | 100 | warning comment in generated SQL |
| SQL length in migrations | 100,000 chars | warning comment in generated SQL |

To use a custom validator set (e.g. disable checks in tests, or add your own rules):

```typescript
import { D1_VALIDATORS, runValidators } from 'jiku';
import type { QueryValidator } from 'jiku';

const noDrops: QueryValidator = (q) => {
  if (q.sql.includes('DROP')) throw new Error('DROP not allowed');
};

// extend
await queryAll(env.DB, query, posts, [...D1_VALIDATORS, noDrops]);

// disable all checks
await queryAll(env.DB, query, posts, []);
```

Wide tables and batch inserts are the most common ways to hit the 100-parameter limit. An INSERT into a 98-column table already uses 98 parameters.

## 6. Migration Gotchas

### NOT NULL column with foreign key on existing table

SQLite's `ALTER TABLE ADD COLUMN` cannot include `REFERENCES` for NOT NULL columns. jiku emits a warning and omits the FK:

```sql
-- WARNING: cannot add NOT NULL column "categoryId" with FK to existing table "posts"; make it nullable or rebuild
ALTER TABLE "posts" ADD COLUMN "categoryId" INTEGER NOT NULL;
```

Fix — make the column nullable so the FK can be inlined:

```typescript
categoryId: v.nullable(v.pipe(v.number(), v.integer()))
// generates: ALTER TABLE "posts" ADD COLUMN "categoryId" INTEGER REFERENCES "categories"("id")
```

### Table recreation for constrained column drops

Dropping a column that is part of a PRIMARY KEY or UNIQUE index requires full table recreation. jiku generates 10 chunked `INSERT` statements (default 5,000 rows each = 50,000 rows total):

```sql
-- WARNING: table "posts" must be recreated (constrained column drop). Data is copied in chunks of 5000 rows.
INSERT INTO "posts_new" SELECT ... FROM "posts" WHERE rowid BETWEEN 1 AND 5000;
-- ... 9 more chunks
-- If "posts" has more than 50000 rows, add more INSERT statements following the same pattern
```

If your table exceeds 50,000 rows, extend the pattern manually in the generated SQL before applying.

### Foreign keys and PRAGMA

When any FK is present, jiku automatically prepends `PRAGMA foreign_keys = ON;` to the migration.

### Modified columns

SQLite cannot `ALTER COLUMN`. jiku emits a warning comment — you must handle the change manually or rebuild the table:

```sql
-- WARNING: column "posts"."title" changed; SQLite cannot ALTER COLUMN — handle manually
```
