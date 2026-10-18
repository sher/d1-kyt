import type postgres from 'postgres';
import { expectTypeOf, it } from 'vitest';
import type { SqlClient, SqlRoot } from './executor.js';

it('accepts a postgres.js client', () => {
  expectTypeOf<postgres.Sql>().toExtend<SqlRoot>();
  expectTypeOf<postgres.TransactionSql>().toExtend<SqlClient>();
});
