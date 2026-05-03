# d1-kyt

Type-safe [Cloudflare D1](https://developers.cloudflare.com/d1/) toolkit built on [Kysely](https://kysely.dev/) and [Valibot](https://valibot.dev/). Define your schema once in Valibot — get SQL migrations and fully-typed queries with no code generation.

```typescript
import { defineTable, InferDB, createQueryBuilder } from 'd1-kyt';
import { queryAll, queryFirst, queryRun } from 'd1-kyt';
import * as v from 'valibot';

export const posts = defineTable('posts', {
  title:      v.string(),
  published:  v.boolean(),
  views:      v.pipe(v.number(), v.integer()),
  categoryId: v.optional(v.pipe(v.number(), v.integer())),
  meta:       v.object({ og: v.string() }),        // stored as JSON
}, {
  foreignKeys: [{ columns: ['categoryId'], references: categories, onDelete: 'CASCADE' }],
  indexes: [{ columns: ['title'], unique: true }],
});

export type DB = InferDB<{ posts: typeof posts }>;
export const db = createQueryBuilder<DB>();

// Type-safe queries — JSON and boolean columns deserialize automatically
const all  = await queryAll(env.DB, db.selectFrom('posts').selectAll().compile());
const one  = await queryFirst(env.DB, db.selectFrom('posts').where('id', '=', 1).selectAll().compile());
const done = await queryRun(env.DB, db.deleteFrom('posts').where('id', '=', 1).compile());
```

## Install

```bash
npm install d1-kyt kysely valibot
```

## Workflow

```
schema.ts  →  schema:diff  →  .sql migration  →  wrangler apply  →  typed queries
```

1. Define tables with Valibot types in `schema.ts`
2. Run `d1-kyt schema:diff <name>` — diffs against a snapshot, writes a `.sql` migration
3. Apply with `wrangler d1 migrations apply <db> --local`
4. Use `$inferSelect` / `$inferInsert` from your schema for typed queries

---

## Quick start

```bash
d1-kyt init                              # scaffold config + schema in db/
d1-kyt schema:diff create_posts          # generates db/migrations/0001_create_posts.sql
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
| `v.optional(X)` | nullable | |
| `v.nullable(X)` | nullable | |
| `v.optional(X, default)` | DEFAULT val | |

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
  foreignKeys: [{ columns: ['categoryId'], references: categories, onDelete: 'CASCADE' }],
});
```

`PRAGMA foreign_keys = ON` is automatically prepended to any migration that includes FK constraints.

Adding a FK column to an existing table requires a nullable column (SQLite limitation):

```typescript
deptId: v.optional(v.pipe(v.number(), v.integer()))  // ✓ nullable allows inline REFERENCES
```

---

## CLI

```bash
d1-kyt init [--dir <dir>]
d1-kyt schema:diff <name> [--dir <dir>] [--schema <path>]
```

**Always commit `schema.json` alongside each `.sql` migration** — it is the diff baseline.

### Config

```typescript
// db/config.ts
import { defineConfig } from 'd1-kyt';

export default defineConfig({
  migrationsDir: 'db/migrations',
  namingStrategy: 'sequential',  // or 'timestamp'
});
```

---

## D1 limits

d1-kyt enforces D1's hard limits at runtime and emits warnings in generated migrations:

| Limit | Value |
|-------|-------|
| Bound parameters per query | 100 |
| SQL statement length | 100,000 chars |
| Columns per table | 100 (warning in migration) |

Custom validators:

```typescript
import { D1_VALIDATORS, runValidators } from 'd1-kyt';
import type { QueryValidator } from 'd1-kyt';

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
| `defineIndex(table, columns, opts?)` | Define an index (columns are type-checked) |
| `defineTrigger(name, opts)` | Define a custom trigger |
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
