# d1-kyt

Opinionated [Cloudflare D1](https://developers.cloudflare.com/d1/) + [Kysely](https://kysely.dev/) toolkit.

**ky**(sely) + **t**(oolkit) = **kyt**

> **Not an ORM.** Thin wrapper with helpers that relies on Kysely's type inference and Valibot schemas. No magic, no runtime overhead.

## Install

```bash
npm install d1-kyt kysely valibot
```

## Workflow

```
schema.ts  →  schema:diff  →  .sql migration  →  wrangler apply  →  types from schema
```

1. Define your schema with Valibot types in `schema.ts`
2. Run `d1-kyt schema:diff <name>` — diffs against a snapshot, writes a `.sql` migration
3. Apply with `wrangler d1 migrations apply <db> --local`
4. Use `$inferSelect` / `$inferInsert` from your schema for type-safe queries

No code generation step required — types come directly from the schema file.

---

## Quick start

```bash
# In your Cloudflare Workers project:
d1-kyt init

# Edit the generated schema file, then:
d1-kyt schema:diff create_users

# Apply to local D1:
wrangler d1 migrations apply <db-name> --local
```

`init` auto-detects the right directory. If your wrangler config has `migrations_dir = "db/migrations"`, it places files in `db/`. Otherwise it uses `d1-kyt/`.

---

## Schema

```typescript
// db/schema.ts  (or d1-kyt/schema.ts)
import { defineTable, defineIndex, defineTrigger } from 'd1-kyt/schema';
import * as v from 'valibot';

export const users = defineTable('users', {
  email:  v.string(),                                    // TEXT NOT NULL
  name:   v.optional(v.string()),                        // TEXT (nullable)
  age:    v.optional(v.pipe(v.number(), v.integer())),   // INTEGER (nullable)
  prefs:  v.optional(v.object({ theme: v.string() })),   // TEXT JSON (nullable)
  role:   v.optional(v.string(), 'user'),                // TEXT DEFAULT 'user'
});

export const usersEmailIdx = defineIndex(users, ['email'], { unique: true });

export const auditTrigger = defineTrigger('users_audit_trg', {
  timing: 'AFTER', event: 'INSERT', on: users,
  body: `INSERT INTO audit (action, at) VALUES ('insert', datetime('now'));`,
});
```

### Valibot → SQL type mapping

| Valibot schema | SQL type | Nullable |
|---|---|---|
| `v.string()` | TEXT | NOT NULL |
| `v.number()` | REAL | NOT NULL |
| `v.pipe(v.number(), v.integer(), ...)` | INTEGER | NOT NULL |
| `v.boolean()` | INTEGER | NOT NULL |
| `v.object({...})` or `v.array(...)` | TEXT (JSON) | NOT NULL |
| `v.optional(X)` | type of X | NULL |
| `v.nullable(X)` | type of X | NULL |
| `v.optional(X, defaultVal)` | type of X + DEFAULT | NULL |

### Auto columns

Every table gets `id`, `createdAt`, `updatedAt` by default, plus an `AFTER UPDATE` trigger for `updatedAt`. Control via options:

```typescript
// Disable everything
defineTable('events', { uuid: v.string() }, {
  primaryKey: false, createdAt: false, updatedAt: false,
})

// Custom names (snake_case)
defineTable('users', { email: v.string() }, {
  primaryKeyColumn: 'user_id',
  createdAtColumn: 'created_at',
  updatedAtColumn: 'updated_at',
})
```

---

## CLI

```bash
d1-kyt init [--dir <dir>]                          # scaffold config + schema template
d1-kyt schema:diff <name> [--dir <dir>]            # diff schema → write .sql migration
d1-kyt schema:diff <name> --schema <path>          # use a custom schema file path
```

### `init`

Creates (skips if already exists):
- `<dir>/config.ts` — migrationsDir + namingStrategy
- `<dir>/schema.ts` — schema template to fill in
- `<dir>/schema.snapshot.jsonc` — diff baseline (**commit this to git**)

Directory resolution:
1. `--dir <path>` if provided
2. Parent of wrangler `migrations_dir` (e.g. `db/` when `migrations_dir = "db/migrations"`)
3. `d1-kyt/` as fallback

### `schema:diff <name>`

Reads your `schema.ts`, diffs against `schema.snapshot.jsonc`, writes a numbered `.sql` file to your `migrationsDir`, and updates the snapshot. **Commit the `.sql` and the snapshot together** — they are the source of truth for migration history.

```bash
d1-kyt schema:diff create_users          # generates 0001_create_users.sql
d1-kyt schema:diff add_email_index       # generates 0002_add_email_index.sql
d1-kyt schema:diff --dir db add_posts    # use db/config.ts, db/schema.ts
```

### Config

```typescript
// db/config.ts  (or d1-kyt/config.ts)
import { defineConfig } from 'd1-kyt/config';

export default defineConfig({
  migrationsDir: 'db/migrations',
  namingStrategy: 'sequential',  // or 'timestamp'
});
```

---

## Type inference

Types come directly from your schema — no code generation step required:

```typescript
import { users } from './db/schema';

// Full row returned by SELECT
type UserRow = typeof users.$inferSelect;
// { id: number; email: string; name: string | undefined; age: number | undefined;
//   prefs: { theme: string } | undefined; role: string | undefined;
//   createdAt: string; updatedAt: string }

// Input for INSERT
type NewUser = typeof users.$inferInsert;
// { email: string; name?: string | undefined; age?: number | undefined; ... id?: number }
```

### Building a DB type for Kysely

```typescript
// db/index.ts
import { users } from './schema';

export type DB = {
  users: typeof users.$inferSelect;
  // ... add other tables
};
```

---

## Query Builder

```typescript
// src/queries.ts
import { createQueryBuilder } from 'd1-kyt';
import type { DB } from './db';

const db = createQueryBuilder<DB>();

export const listUsers = () =>
  db.selectFrom('users').selectAll().compile();

export const getUserByEmail = (email: string) =>
  db.selectFrom('users').selectAll().where('email', '=', email).compile();

export const insertUser = (email: string, name?: string) =>
  db.insertInto('users').values({ email, name }).returning(['id']).compile();
```

## Execute Queries

```typescript
// src/app.ts
import { Hono } from 'hono';
import { queryAll, queryFirst, queryRun } from 'd1-kyt';
import * as q from './queries';

const app = new Hono();

app.get('/users', async (c) => {
  const users = await queryAll(c.env.DB, q.listUsers());
  return c.json(users);
});

app.get('/users/:email', async (c) => {
  const user = await queryFirst(c.env.DB, q.getUserByEmail(c.req.param('email')));
  return user ? c.json(user) : c.notFound();
});

app.post('/users', async (c) => {
  const { email, name } = await c.req.json();
  const [user] = await queryAll(c.env.DB, q.insertUser(email, name));
  return c.json(user, 201);
});
```

---

## Partial indexes

```typescript
defineIndex(users, ['email'], {
  unique: true,
  where: '"active" = 1',   // raw SQL string
})
```

---

## Conventions

- Auto `id INTEGER PRIMARY KEY AUTOINCREMENT`, `createdAt TEXT`, `updatedAt TEXT` on every table (all configurable/disableable)
- Auto `AFTER UPDATE` trigger to keep `updatedAt` current
- Index naming: `{table}_{cols}_idx` / `{table}_{cols}_uq`
- Trigger naming: `{table}_{col}_trg`
- `schema.snapshot.jsonc` is the diff source of truth — always commit it alongside migration SQL files

---

## API reference

### `d1-kyt/schema`

| Export | Description |
|---|---|
| `defineTable(name, columns, opts?)` | Define a table; returns `SchemaTable` with `$inferSelect` / `$inferInsert` |
| `defineIndex(table, columns, opts?)` | Define an index (columns are type-checked against the table) |
| `defineTrigger(name, opts)` | Define a custom trigger attached to a table |
| `sqlTypeFromSchema(schema)` | Inspect a Valibot schema → `{ type, notNull, default?, isJson }` |
| `TableOptions` | Options type for auto columns (re-exported) |

### `d1-kyt` (main)

| Export | Description |
|---|---|
| `createQueryBuilder<DB>()` | Kysely instance (compile-only, no execution) |
| `queryAll(db, query)` | Execute query, return all rows |
| `queryFirst(db, query)` | Execute query, return first row or null |
| `queryRun(db, query)` | Execute mutation, return run metadata |
| `queryBatch(db, queries)` | Execute multiple queries as a D1 batch |

### `d1-kyt/config`

| Export | Description |
|---|---|
| `defineConfig(config)` | Define `config.ts` (typed helper) |

---

## Legacy migrate API

The imperative migration DSL (`d1-kyt/migrate`) is still available but superseded by the schema-first approach above. It will be removed in a future major version.

```typescript
// d1-kyt/migrations/0001_create_users.ts
import { defineTable, createIndex } from 'd1-kyt/migrate';

const users = defineTable('users', (col) => ({
  email: col.text().notNull(),
  name:  col.text(),
}));

export const migration = () => [
  ...users.sql,
  createIndex(users, ['email'], { unique: true }),
];
```

---

## License

MIT
