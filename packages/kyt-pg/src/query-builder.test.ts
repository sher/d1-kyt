import { describe, expect, it } from 'vitest';
import { createQueryBuilder } from './query-builder.js';

describe('createQueryBuilder', () => {
  it('compiles Postgres placeholders and quoted names', () => {
    type DB = { User: { id: bigint; email: string } };
    const q = createQueryBuilder<DB>().selectFrom('User').select('email').where('id', '=', 1n).compile();
    expect(q.sql).toBe('select "email" from "User" where "id" = $1');
    expect(q.parameters).toEqual([1n]);
  });

  it('supports returning', () => {
    type DB = { User: { id: bigint; email: string } };
    const q = createQueryBuilder<DB>().insertInto('User').values({ id: 1n, email: 'a' }).returning('id').compile();
    expect(q.sql).toContain('returning "id"');
  });
});
