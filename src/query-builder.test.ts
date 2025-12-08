import { describe, it, expect } from 'vitest';
import { createQueryBuilder } from './query-builder.js';

interface TestDB {
  User: {
    id: number;
    name: string;
    email: string;
  };
}

describe('createQueryBuilder', () => {
  it('creates a kysely instance', () => {
    const db = createQueryBuilder<TestDB>();
    expect(db).toBeDefined();
  });

  it('compiles select queries', () => {
    const db = createQueryBuilder<TestDB>();
    const compiled = db.selectFrom('User').selectAll().compile();

    expect(compiled.sql).toBe('select * from "User"');
    expect(compiled.parameters).toEqual([]);
  });

  it('compiles queries with parameters', () => {
    const db = createQueryBuilder<TestDB>();
    const compiled = db
      .selectFrom('User')
      .selectAll()
      .where('id', '=', 1)
      .compile();

    expect(compiled.sql).toBe('select * from "User" where "id" = ?');
    expect(compiled.parameters).toEqual([1]);
  });

  it('compiles insert queries', () => {
    const db = createQueryBuilder<TestDB>();
    const compiled = db
      .insertInto('User')
      .values({ id: 1, name: 'Test', email: 'test@example.com' })
      .compile();

    expect(compiled.sql).toBe(
      'insert into "User" ("id", "name", "email") values (?, ?, ?)'
    );
    expect(compiled.parameters).toEqual([1, 'Test', 'test@example.com']);
  });

  it('compiles update queries', () => {
    const db = createQueryBuilder<TestDB>();
    const compiled = db
      .updateTable('User')
      .set({ name: 'Updated' })
      .where('id', '=', 1)
      .compile();

    expect(compiled.sql).toBe('update "User" set "name" = ? where "id" = ?');
    expect(compiled.parameters).toEqual(['Updated', 1]);
  });

  it('compiles delete queries', () => {
    const db = createQueryBuilder<TestDB>();
    const compiled = db.deleteFrom('User').where('id', '=', 1).compile();

    expect(compiled.sql).toBe('delete from "User" where "id" = ?');
    expect(compiled.parameters).toEqual([1]);
  });
});
