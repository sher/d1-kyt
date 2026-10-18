import type { CompiledQuery } from 'kysely';

export type QueryValidator = (query: CompiledQuery<unknown>) => void;

export const D1_MAX_BOUND_PARAMETERS = 100;
export const D1_MAX_SQL_LENGTH = 100_000;
export const D1_MAX_COLUMNS = 100;

export const d1MaxParams: QueryValidator = (query) => {
  if (query.parameters.length > D1_MAX_BOUND_PARAMETERS) {
    throw new Error(
      `D1 limit: query has ${query.parameters.length} bound parameters (max ${D1_MAX_BOUND_PARAMETERS}). ` +
        `Split into multiple queries or reduce the number of columns.`,
    );
  }
};

export const d1MaxSqlLength: QueryValidator = (query) => {
  if (query.sql.length > D1_MAX_SQL_LENGTH) {
    throw new Error(
      `D1 limit: SQL statement is ${query.sql.length} characters (max ${D1_MAX_SQL_LENGTH}). ` +
        `Simplify the query or split it into smaller statements.`,
    );
  }
};

export const D1_VALIDATORS: QueryValidator[] = [d1MaxParams, d1MaxSqlLength];

export function runValidators(
  query: CompiledQuery<unknown>,
  validators: QueryValidator[] = D1_VALIDATORS,
): void {
  for (const validate of validators) {
    validate(query);
  }
}
