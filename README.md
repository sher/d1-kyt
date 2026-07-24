# jiku

Type-safe [Cloudflare D1](https://developers.cloudflare.com/d1/) toolkit built on [Kysely](https://kysely.dev/) and [Valibot](https://valibot.dev/). Define your schema once in Valibot — get SQL migrations and fully-typed queries with no code generation.

```typescript
import { defineTable, defineIndex, withDefault, InferDB, createQueryBuilder, queryAll, queryFirst } from 'jiku';
import * as v from 'valibot';

export const users = defineTable('users', {
  email:    v.string(),
  verified: withDefault(v.boolean(), false),      // NOT NULL DEFAULT 0, optional on insert
  name:     v.nullable(v.string()),               // NULL allowed
  prefs:    v.object({ theme: v.string() }),      // stored as JSON → returned as object
});

export const posts = defineTable('posts', {
  title:    v.string(),
  views:    v.pipe(v.number(), v.integer()),
  authorId: v.pipe(v.number(), v.integer()),
}, {
  foreignKeys: [{ columns: ['authorId'], references: users }],
});

export const postsTitleIdx = defineIndex(posts, ['title'], { unique: true });

export type DB = InferDB<{ users: typeof users; posts: typeof posts }>;
export const db = createQueryBuilder<DB>();

// prefs is { theme: string }, verified is boolean — deserialized automatically
const verified = await queryAll(
  env.DB,
  db.selectFrom('users').selectAll().where('verified', '=', true).compile(),
);

// full Kysely — joins, subqueries, window functions, all type-checked
const popular = await queryFirst(
  env.DB,
  db.selectFrom('posts')
    .innerJoin('users', 'users.id', 'posts.authorId')
    .select(['posts.title', 'posts.views', 'users.email'])
    .where('posts.views', '>', 1000)
    .orderBy('posts.views', 'desc')
    .compile(),
);
```

## Install

```bash
npm install jiku kysely valibot
```

## Workflow

```
schema.ts  →  schema:diff  →  .sql migration  →  wrangler apply  →  typed queries
```

1. Define tables with Valibot types in `schema.ts`
2. Run `jiku schema:diff <name>` — diffs against a snapshot, writes a `.sql` migration
3. Apply with `wrangler d1 migrations apply <db> --local`
4. Use `$inferSelect` / `$inferInsert` from your schema for typed queries

---

## Quick start

```bash
jiku init                              # scaffold config + schema in db/
jiku schema:diff create_posts          # generates db/migrations/0001_create_posts.sql
wrangler d1 migrations apply <db> --local
```

---

## Schema

### Valibot → SQL type mapping

| Valibot | SQL | Notes |
|---------|-----|-------|
| `v.string()` | TEXT NOT NULL | |
| `v.number()` | REAL NOT NULL | |
| `v.pipe(v.number(), v.integer())` | INTEGER NOT NULL | |
| `v.boolean()` | INTEGER NOT NULL | stored as 0/1, returned as `boolean` |
| `v.object({...})` / `v.array(...)` | TEXT NOT NULL | JSON serialized |
| `v.nullable(X)` | nullable (NULL) | select type is `T \| null` |
| `withDefault(X, val)` | NOT NULL DEFAULT val | optional on insert, `T` on select |

### Auto columns

Every table gets `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `createdAt` (TEXT), and `updatedAt` (TEXT) with an `AFTER UPDATE` trigger. All configurable:

```typescript
// Disable everything
defineTable('events', { uuid: v.string() }, {
  primaryKey: false, createdAt: false, updatedAt: false,
})

// Custom names
defineTable('users', { email: v.string() }, {
  primaryKeyColumn: 'user_id',
  createdAtColumn: 'created_at',
  updatedAtColumn: 'updated_at',
})
```

---

## Type inference

```typescript
type PostRow = typeof posts.$inferSelect;
// { id: number; title: string; published: boolean; views: number; ... }

type NewPost = typeof posts.$inferInsert;
// { title: string; published: boolean; views: number; id?: number; ... }
```

---

## Foreign keys

```typescript
export const categories = defineTable('categories', { name: v.string() });

export const posts = defineTable('posts', {
  title:      v.string(),
  categoryId: v.pipe(v.number(), v.integer()),
}, {
  foreignKeys: [{
    columns:    ['categoryId'],
    references: categories,
    refColumns: ['id'],           // optional — defaults to the referenced table's PK
    onDelete:   'CASCADE',        // CASCADE | SET NULL | RESTRICT | NO ACTION
    onUpdate:   'NO ACTION',
  }],
});
```

`PRAGMA foreign_keys = ON` is automatically prepended to any migration that includes FK constraints.

Adding a FK column to an existing table requires a nullable column (SQLite limitation):

```typescript
deptId: v.nullable(v.pipe(v.number(), v.integer()))  // ✓ nullable allows inline REFERENCES
```

---

## Indexes

```typescript
// Basic unique index
export const postsSlugIdx = defineIndex(posts, ['slug'], { unique: true });

// Composite index
export const postsAuthorViewsIdx = defineIndex(posts, ['authorId', 'views']);

// Partial index — only indexes rows matching the WHERE clause
export const postsPublishedIdx = defineIndex(posts, ['createdAt'], {
  where: 'published = 1',
});

// Custom index name
export const postsSearchIdx = defineIndex(posts, ['title'], {
  name: 'posts_title_fts_idx',
});
```

Columns are type-checked against the table definition at compile time.

---

## CLI

```bash
jiku init [--dir <dir>]
jiku schema:diff <name> [--dir <dir>] [--schema <path>]
```

**Always commit `schema.json` alongside each `.sql` migration** — it is the diff baseline.

### Config

```typescript
// db/config.ts
import { defineConfig } from 'jiku';

export default defineConfig({
  migrationsDir: 'db/migrations',
  namingStrategy: 'sequential',  // or 'timestamp'
});
```

---

## D1 limits

jiku enforces D1's hard limits at runtime and emits warnings in generated migrations:

| Limit | Value |
|-------|-------|
| Bound parameters per query | 100 |
| SQL statement length | 100,000 chars |
| Columns per table | 100 (warning in migration) |

Custom validators:

```typescript
import { D1_VALIDATORS, runValidators } from 'jiku';
import type { QueryValidator } from 'jiku';

const noDrops: QueryValidator = (q) => {
  if (q.sql.includes('DROP')) throw new Error('DROP not allowed');
};

await queryAll(env.DB, query, undefined, [...D1_VALIDATORS, noDrops]);
await queryAll(env.DB, query, undefined, []);  // disable all checks
```

---

## API reference

### Schema

| Export | Description |
|--------|-------------|
| `defineTable(name, columns, opts?)` | Define a table; returns `SchemaTable` with `$inferSelect` / `$inferInsert` |
| `defineIndex(table, columns, opts?)` | Define an index; columns are type-checked. `opts`: `unique`, `name`, `where` (partial index) |
| `defineTrigger(name, opts)` | Define a custom trigger |
| `withDefault(schema, value)` | Mark a column as NOT NULL with a DB-level default; optional on insert |
| `InferDB<Tables>` | Infer a Kysely-compatible `DB` type |

### Execution

| Export | Description |
|--------|-------------|
| `createQueryBuilder<DB>()` | Compile-only Kysely instance |
| `queryAll(db, query, table?, validators?)` | All rows; JSON + boolean columns auto-deserialized |
| `queryFirst(db, query, table?, validators?)` | First row or null; auto-deserialized |
| `queryRun(db, query, validators?)` | INSERT / UPDATE / DELETE |
| `queryBatch(db, queries, validators?)` | Atomic batch |

### Validators

| Export | Description |
|--------|-------------|
| `D1_VALIDATORS` | Default validator array |
| `d1MaxParams` | Enforces ≤ 100 bound parameters |
| `d1MaxSqlLength` | Enforces ≤ 100,000 char SQL |
| `runValidators(query, validators?)` | Run validators manually |

---

## License

MIT
