import { describe, expect, it } from 'vitest';
import { findTransactionStatement } from './sql-scan.js';

describe('findTransactionStatement', () => {
  it('finds transaction statements at the start of a statement', () => {
    expect(findTransactionStatement('BEGIN;\ncreate table "A" ("id" int);')).toBe('BEGIN');
    expect(findTransactionStatement('create table "A" ("id" int);\ncommit;')).toBe('COMMIT');
    expect(findTransactionStatement('create table "A" ("id" int); END;')).toBe('END');
    expect(findTransactionStatement('START TRANSACTION;')).toBe('START');
    expect(findTransactionStatement('ROLLBACK;')).toBe('ROLLBACK');
    expect(findTransactionStatement('abort;')).toBe('ABORT');
    expect(findTransactionStatement('begin work;')).toBe('BEGIN');
  });

  it('allows a generated trigger function', () => {
    const sql = [
      'CREATE OR REPLACE FUNCTION "User_updatedAt_trg_fn"() RETURNS trigger LANGUAGE plpgsql AS $$',
      'BEGIN',
      '  NEW."updatedAt" = now();',
      '  RETURN NEW;',
      'END $$;',
      'CREATE TRIGGER "User_updatedAt_trg" BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION "User_updatedAt_trg_fn"();',
    ].join('\n');
    expect(findTransactionStatement(sql)).toBeUndefined();
  });

  it('skips comments, strings, quoted names and tagged dollar bodies', () => {
    expect(findTransactionStatement('-- COMMIT;\nselect 1;')).toBeUndefined();
    expect(findTransactionStatement('/* BEGIN; */ select 1;')).toBeUndefined();
    expect(findTransactionStatement("insert into \"Note\" (\"text\") values ('x; COMMIT;');")).toBeUndefined();
    expect(findTransactionStatement('select 1 as "a; commit";')).toBeUndefined();
    expect(findTransactionStatement('do $body$ BEGIN PERFORM 1; END; $body$;')).toBeUndefined();
  });

  it('allows savepoint statements', () => {
    expect(findTransactionStatement('SAVEPOINT s; ROLLBACK TO SAVEPOINT s; RELEASE SAVEPOINT s;')).toBeUndefined();
  });

  it('does not match words that only start the same way', () => {
    expect(findTransactionStatement('select 1 as "x";\nbeginning_of_nothing;')).toBeUndefined();
    expect(findTransactionStatement('ENDPOINT;')).toBeUndefined();
  });
});
