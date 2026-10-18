import { describe, it, expect } from 'vitest';
import {
  d1MaxParams,
  d1MaxSqlLength,
  runValidators,
  D1_VALIDATORS,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_LENGTH,
} from './validators.js';
import type { QueryValidator } from './validators.js';

function makeQuery(sql: string, parameters: unknown[] = []) {
  return { sql, parameters, query: {} as any };
}

describe('d1MaxParams', () => {
  it('passes with 0 parameters', () => {
    expect(() => d1MaxParams(makeQuery('SELECT 1'))).not.toThrow();
  });

  it(`passes at exactly ${D1_MAX_BOUND_PARAMETERS} parameters`, () => {
    expect(() => d1MaxParams(makeQuery('SELECT 1', new Array(100).fill(1)))).not.toThrow();
  });

  it(`throws with ${D1_MAX_BOUND_PARAMETERS + 1} parameters`, () => {
    expect(() => d1MaxParams(makeQuery('SELECT 1', new Array(101).fill(1)))).toThrow(
      /101 bound parameters.*max 100/,
    );
  });

  it('includes the parameter count in the error message', () => {
    expect(() => d1MaxParams(makeQuery('SELECT 1', new Array(150).fill(1)))).toThrow(/150/);
  });
});

describe('d1MaxSqlLength', () => {
  it('passes with short SQL', () => {
    expect(() => d1MaxSqlLength(makeQuery('SELECT 1'))).not.toThrow();
  });

  it(`passes at exactly ${D1_MAX_SQL_LENGTH} characters`, () => {
    expect(() => d1MaxSqlLength(makeQuery('x'.repeat(D1_MAX_SQL_LENGTH)))).not.toThrow();
  });

  it(`throws with ${D1_MAX_SQL_LENGTH + 1} characters`, () => {
    expect(() => d1MaxSqlLength(makeQuery('x'.repeat(D1_MAX_SQL_LENGTH + 1)))).toThrow(
      /100001 characters.*max 100000/,
    );
  });

  it('includes the actual length in the error message', () => {
    expect(() => d1MaxSqlLength(makeQuery('x'.repeat(200_000)))).toThrow(/200000/);
  });
});

describe('runValidators', () => {
  it('passes a valid query through all default validators', () => {
    expect(() => runValidators(makeQuery('SELECT 1', [1, 2, 3]))).not.toThrow();
  });

  it('applies default D1_VALIDATORS when none provided', () => {
    const query = makeQuery('SELECT 1', new Array(101).fill(1));
    expect(() => runValidators(query)).toThrow(/bound parameters/);
  });

  it('stops at the first failing validator', () => {
    const calls: string[] = [];
    const v1: QueryValidator = () => {
      calls.push('v1');
      throw new Error('v1 fail');
    };
    const v2: QueryValidator = () => {
      calls.push('v2');
    };
    expect(() => runValidators(makeQuery('SELECT 1'), [v1, v2])).toThrow('v1 fail');
    expect(calls).toEqual(['v1']);
  });

  it('runs all validators when none fail', () => {
    const calls: string[] = [];
    const v1: QueryValidator = () => calls.push('v1');
    const v2: QueryValidator = () => calls.push('v2');
    runValidators(makeQuery('SELECT 1'), [v1, v2]);
    expect(calls).toEqual(['v1', 'v2']);
  });

  it('accepts a custom validator list, ignoring D1_VALIDATORS', () => {
    const noDrops: QueryValidator = (q) => {
      if (q.sql.includes('DROP')) throw new Error('DROP not allowed');
    };
    // Would pass default validators (short SQL, no params) but fails custom one
    expect(() => runValidators(makeQuery('DROP TABLE foo'), [noDrops])).toThrow('DROP not allowed');
    expect(() => runValidators(makeQuery('SELECT 1'), [noDrops])).not.toThrow();
  });

  it('accepts an empty validator list (no-op)', () => {
    const query = makeQuery('SELECT 1', new Array(200).fill(1));
    expect(() => runValidators(query, [])).not.toThrow();
  });

  it('can extend D1_VALIDATORS with a custom rule', () => {
    const noSelect: QueryValidator = (q) => {
      if (q.sql.startsWith('SELECT')) throw new Error('SELECT not allowed');
    };
    const extended = [...D1_VALIDATORS, noSelect];
    expect(() => runValidators(makeQuery('SELECT 1'), extended)).toThrow('SELECT not allowed');
    // D1 validators still apply
    expect(() => runValidators(makeQuery('INSERT 1', new Array(101).fill(1)), extended)).toThrow(
      /bound parameters/,
    );
  });
});
