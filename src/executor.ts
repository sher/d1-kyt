import type { CompiledQuery } from 'kysely';
import type { SchemaTable } from './schema.js';
import { sqlTypeFromSchema } from './schema.js';
import { runValidators } from './validators.js';
import type { QueryValidator } from './validators.js';

/**
 * Serialize a query parameter for D1 binding.
 * D1 accepts: null | string | number | boolean | ArrayBuffer | ArrayBufferView.
 * Plain objects and arrays (JSON columns) must be stringified.
 */
function serializeParam(p: unknown): unknown {
  if (p === null || p === undefined) return p;
  if (typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean') return p;
  if (p instanceof ArrayBuffer || ArrayBuffer.isView(p)) return p;
  return JSON.stringify(p);
}

function deserializeRow<T>(row: Record<string, unknown>, table: SchemaTable<any, any>): T {
  const result = { ...row };
  for (const col of Object.keys(table._columns)) {
    if (col in result && typeof result[col] === 'string') {
      if (sqlTypeFromSchema(table._columns[col]).isJson) {
        result[col] = JSON.parse(result[col] as string);
      }
    }
  }
  return result as T;
}

/**
 * D1 query result with metadata
 */
export interface D1RunResult {
  success: boolean;
  meta: {
    duration: number;
    rows_read: number;
    rows_written: number;
    last_row_id: number;
    changed_db: boolean;
    changes: number;
  };
}

/**
 * D1Database interface (subset of Cloudflare's D1Database)
 * Compatible with wrangler-generated types
 */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1Result<unknown>>;
}

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: {
    duration: number;
    rows_read: number;
    rows_written: number;
    last_row_id: number;
    changed_db: boolean;
    changes: number;
  };
}

/**
 * Execute query and return all rows
 *
 * @example
 * ```ts
 * const users = await queryAll(env.DB, queries.listUsers());
 * ```
 */
export async function queryAll<T>(
  db: D1Database,
  query: CompiledQuery<T>,
  table?: SchemaTable<any, any>,
  validators?: QueryValidator[],
): Promise<T[]> {
  runValidators(query as CompiledQuery<unknown>, validators);
  const result = await db
    .prepare(query.sql)
    .bind(...query.parameters.map(serializeParam))
    .all<T>();
  const rows = result.results ?? [];
  return table ? rows.map((r) => deserializeRow<T>(r as Record<string, unknown>, table)) : rows;
}

/**
 * Execute query and return first row or null
 *
 * @example
 * ```ts
 * const user = await queryFirst(env.DB, queries.getUserById({ id: 1 }));
 * ```
 */
export async function queryFirst<T>(
  db: D1Database,
  query: CompiledQuery<T>,
  table?: SchemaTable<any, any>,
  validators?: QueryValidator[],
): Promise<T | null> {
  runValidators(query as CompiledQuery<unknown>, validators);
  const result = await db
    .prepare(query.sql)
    .bind(...query.parameters.map(serializeParam))
    .first<T>();
  if (result == null) return null;
  return table ? deserializeRow<T>(result as Record<string, unknown>, table) : result;
}

/**
 * Execute query without returning rows (INSERT/UPDATE/DELETE)
 *
 * @example
 * ```ts
 * const result = await queryRun(env.DB, queries.deleteUser({ id: 1 }));
 * console.log(result.meta.changes);
 * ```
 */
export async function queryRun(
  db: D1Database,
  query: CompiledQuery<unknown>,
  validators?: QueryValidator[],
): Promise<D1RunResult> {
  runValidators(query, validators);
  const result = await db
    .prepare(query.sql)
    .bind(...query.parameters.map(serializeParam))
    .run();
  return {
    success: result.success,
    meta: result.meta,
  };
}

/**
 * Execute multiple queries in a batch (transaction-like)
 *
 * @example
 * ```ts
 * const results = await queryBatch(env.DB, [
 *   queries.createUser({ name: 'A' }),
 *   queries.createUser({ name: 'B' }),
 * ]);
 * ```
 */
export async function queryBatch(
  db: D1Database,
  queries: readonly CompiledQuery<unknown>[],
  validators?: QueryValidator[],
): Promise<D1RunResult[]> {
  for (const q of queries) runValidators(q, validators);
  const statements = queries.map((q) =>
    db.prepare(q.sql).bind(...q.parameters.map(serializeParam))
  );
  const results = await db.batch(statements);
  return results.map((r) => ({
    success: r.success,
    meta: r.meta,
  }));
}
