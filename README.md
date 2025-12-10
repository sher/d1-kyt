# d1-kyt

Opinionated [Cloudflare D1](https://developers.cloudflare.com/d1/) + [Kysely](https://kysely.dev/) toolkit.

**ky**(sely) + **t**(oolkit) = **kyt**

> **Not an ORM.** Thin wrapper with helpers that relies on Kysely's type inference. No magic, no runtime overhead.

## Migration DSL

```typescript
// d1-kyt/migrations/0001_create_user_table.ts

import { defineTable, createIndex } from 'd1-kyt/migrate';

const User = defineTable('User', (col) => ({
  externalId: col.text().notNull(),
  email: col.text().notNull(),
  name: col.text(),
}));

export const migration = () => [
  ...User.sql,
  createIndex(User, ['externalId'], { unique: true }),
  createIndex(User, ['email'], { unique: true }),
];
```

### Customizing Auto Columns

```typescript
// Disable all auto columns
const Event = defineTable('Event', (col) => ({
  uuid: col.text().notNull(),
  name: col.text().notNull(),
}), { id: false, createdAt: false, updatedAt: false });

// Custom column names (snake_case)
const User = defineTable('user', (col) => ({
  email: col.text().notNull(),
}), {
  idColumn: 'user_id',
  createdAtColumn: 'created_at',
  updatedAtColumn: 'updated_at',
});
```

### Later Migrations

Use `createUseTable` for type-safe references to existing tables:

```typescript
import type { DB } from '../../db/generated';
import { createUseTable, addColumn, createIndex } from 'd1-kyt/migrate';

const useTable = createUseTable<DB>();
const User = useTable('User');

export const migration = () => [
  addColumn(User, 'age', (col) => col.integer()),
  createIndex(User, ['age']),
];
```

## Query Builder

```typescript
// src/queries.ts

import { createQueryBuilder } from 'd1-kyt';
import type { DB } from './db/generated';

const db = createQueryBuilder<DB>();

export const getUsers = () => db.selectFrom('User').selectAll().compile();

export const getUser = (id: number) =>
  db.selectFrom('User').selectAll().where('id', '=', id).compile();

export const insertUser = (email: string, name: string) =>
  db.insertInto('User').values({ email, name }).returning(['id']).compile();
```

### Execute Queries

```typescript
// src/app.ts

import Hono from 'hono';
import { queryAll, queryFirst, queryRun } from 'd1-kyt';
import * as q from './queries';

const app = new Hono();

app.get('/users', async (c) => {
  const users = await queryAll(c.env.DB, q.getUsers());
  return c.json(users);
});

app.get('/users/:id', async (c) => {
  const user = await queryFirst(c.env.DB, q.getUser(c.req.param('id')));
  return user ? c.json(user) : c.notFound();
});

app.post('/users', async (c) => {
  const { email, name } = await c.req.json();
  const [user] = await queryAll(c.env.DB, q.insertUser(email, name));
  return c.json(user, 201);
});
```

## Install

```bash
npm install d1-kyt kysely kysely-codegen
```

## CLI

```bash
d1-kyt init                      # creates d1-kyt/ folder with config
d1-kyt migrate:create <name>     # creates d1-kyt/migrations/0001_<name>.ts
d1-kyt migrate:build             # compiles *.ts → db/migrations/*.sql
d1-kyt typegen                   # runs kysely-codegen
```

Reads `wrangler.jsonc` to detect `migrations_dir` automatically.

### Configuration

```typescript
// d1-kyt/config.ts

import { defineConfig } from 'd1-kyt/config';

export default defineConfig({
  migrationsDir: 'db/migrations',
  dbDir: 'db',
  namingStrategy: 'sequential', // or 'timestamp'
});
```

## Conventions

- Auto `id`, `createdAt`, `updatedAt` on every table (configurable)
- Auto trigger for `updatedAt`
- Index naming: `{table}_{cols}_idx`, `{table}_{cols}_uq`
- Trigger naming: `{table}_{col}_trg`

## API

| Function                               | Description                       |
| -------------------------------------- | --------------------------------- |
| `defineTable(name, fn, opts?)`         | Define new table                  |
| `createUseTable<DB>()`                 | Factory for typed table refs      |
| `useTable<T>(name)`                    | Reference table (manual typing)   |
| `createIndex(table, cols, opts?)`      | Create index                      |
| `addColumn(table, col, fn)`            | Add column                        |
| `dropTable(table, updatedAtCol?)`      | Drop table + trigger              |
| `dropIndex(name)`                      | Drop index                        |
| `queryAll(db, query)`                  | Execute, return all rows          |
| `queryFirst(db, query)`                | Execute, return first row or null |
| `queryRun(db, query)`                  | Execute mutation                  |
| `queryBatch(db, queries)`              | Execute batch                     |

## License

MIT
