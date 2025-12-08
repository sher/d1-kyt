import type { CompiledQuery } from 'kysely';

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
  query: CompiledQuery<T>
): Promise<T[]> {
  const result = await db
    .prepare(query.sql)
    .bind(...query.parameters)
    .all<T>();
  return result.results ?? [];
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
  query: CompiledQuery<T>
): Promise<T | null> {
  const result = await db
    .prepare(query.sql)
    .bind(...query.parameters)
    .first<T>();
  return result ?? null;
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
  query: CompiledQuery<unknown>
): Promise<D1RunResult> {
  const result = await db
    .prepare(query.sql)
    .bind(...query.parameters)
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
  queries: readonly CompiledQuery<unknown>[]
): Promise<D1RunResult[]> {
  const statements = queries.map((q) =>
    db.prepare(q.sql).bind(...q.parameters)
  );
  const results = await db.batch(statements);
  return results.map((r) => ({
    success: r.success,
    meta: r.meta,
  }));
}
