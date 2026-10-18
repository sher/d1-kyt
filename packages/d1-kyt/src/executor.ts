import type { CompiledQuery, RootOperationNode, OperationNode } from 'kysely';
import { SelectQueryNode, TableNode, AliasNode } from 'kysely';
import type { SchemaTable } from './schema.js';
import { sqlTypeFromSchema, getTableRegistry } from './schema.js';
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

function extractTableNames(node: RootOperationNode): string[] {
  const names = new Set<string>();
  if (!SelectQueryNode.is(node)) return [];

  const collectFrom = (n: OperationNode) => {
    if (TableNode.is(n)) {
      names.add((n as any).table.identifier.name);
    } else if (AliasNode.is(n) && TableNode.is((n as any).node)) {
      names.add((n as any).node.table.identifier.name);
    }
  };

  if (node.from) {
    for (const f of node.from.froms) collectFrom(f);
  }
  if (node.joins) {
    for (const j of node.joins) collectFrom(j.table);
  }
  return Array.from(names);
}

function deserializeRow<T>(row: Record<string, unknown>, tables: SchemaTable<any, any>[]): T {
  const result = { ...row };
  for (const table of tables) {
    for (const col of Object.keys(table._columns)) {
      if (!(col in result)) continue;
      const info = sqlTypeFromSchema(table._columns[col]);
      if (info.isJson && typeof result[col] === 'string') {
        result[col] = JSON.parse(result[col] as string);
      } else if (info.isBoolean && (result[col] === 0 || result[col] === 1)) {
        result[col] = result[col] === 1;
      }
    }
  }
  return result as T;
}

function resolveTables(
  node: RootOperationNode,
  explicit?: SchemaTable<any, any>,
): SchemaTable<any, any>[] {
  if (explicit) return [explicit];
  const registry = getTableRegistry();
  return extractTableNames(node)
    .map((n) => registry.get(n))
    .filter((t): t is SchemaTable<any, any> => t !== undefined);
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
  const tables = resolveTables(query.query, table);
  const result = await db
    .prepare(query.sql)
    .bind(...query.parameters.map(serializeParam))
    .all<T>();
  const rows = result.results ?? [];
  return tables.length > 0
    ? rows.map((r) => deserializeRow<T>(r as Record<string, unknown>, tables))
    : rows;
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
  const tables = resolveTables(query.query, table);
  const result = await db
    .prepare(query.sql)
    .bind(...query.parameters.map(serializeParam))
    .first<T>();
  if (result == null) return null;
  return tables.length > 0
    ? deserializeRow<T>(result as Record<string, unknown>, tables)
    : result;
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
