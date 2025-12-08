# d1-kyt

[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare)](https://developers.cloudflare.com/d1/)
[![Kysely](https://img.shields.io/badge/Kysely-Query_Builder-blue)](https://kysely.dev/)
[![npm](https://img.shields.io/npm/v/d1-kyt)](https://www.npmjs.com/package/d1-kyt)

Opinionated [Cloudflare D1](https://developers.cloudflare.com/d1/) + [Kysely](https://kysely.dev/) toolkit.

Not an ORM, just a wrapper with helpers that relies on Kysely's type inference. No magic, no runtime overhead.

**ky**(sely) + **t**(oolkit) = **kyt**


## Install

```bash
npm install d1-kyt kysely kysely-codegen
```

## CLI

```bash
d1-kyt init                      # creates d1-kyt/ and db/index.ts
d1-kyt migrate:create <name>     # creates d1-kyt/migrations/0001_<name>.ts
d1-kyt migrate:build             # compiles d1-kyt/migrations/*.ts → db/migrations/*.sql
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

## Usage

### Query Builder

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

### Migration DSL

```typescript
// d1-kyt/migrations/0001_create_user_table.ts

import { defineTable, createIndex } from 'd1-kyt/migrate';

const User = defineTable('User', (col) => ({
  externalId: col.text().notNull(), // ULID or similar
  email: col.text().notNull(),
  name: col.text(),
}));

export const migration = () => [
  ...User.sql,
  createIndex(User, ['externalId'], { unique: true }),
  createIndex(User, ['email'], { unique: true }),
];
```

### Later Migrations

Import `useTable` from the generated `db/index.ts`:

```typescript
import { useTable } from '../../db';
import { addColumn, createIndex } from 'd1-kyt/migrate';

const User = useTable('User');

export const migration = () => [
  addColumn(User, 'age', (col) => col.integer()),
  createIndex(User, ['age']),
];
```

## Conventions

- Auto `id`, `createdAt`, `updatedAt` on every table
- Auto trigger for `updatedAt`

## API

| Function                          | Description                       |
| --------------------------------- | --------------------------------- |
| `queryAll(db, query)`             | Execute, return all rows          |
| `queryFirst(db, query)`           | Execute, return first row or null |
| `queryRun(db, query)`             | Execute mutation                  |
| `queryBatch(db, queries)`         | Execute batch                     |
| `defineTable(name, fn)`           | Define new table                  |
| `createUseTable<DB>()`            | Factory for typed table refs      |
| `useTable<T>(name)`               | Reference table (manual typing)   |
| `createIndex(table, cols, opts?)` | Create index                      |
| `addColumn(table, col, fn)`       | Add column                        |
| `dropTable(table)`                | Drop table + trigger              |
| `dropIndex(name)`                 | Drop index                        |

## License

MIT
