/**
 * Migration DSL for D1/SQLite
 * Constrained API - uses limited operations for predictable output
 */

// ----------------------------------------------------------------------------
// Column Definition Types
// ----------------------------------------------------------------------------

type SqliteType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

interface ColumnDefInternal {
  type: SqliteType;
  isNotNull: boolean;
  defaultValue: string | null;
}

/**
 * Column definition - chainable but limited.
 * Only notNull() and default() are available.
 * No unique(), references(), check() - by design.
 */
export interface ColumnDef {
  notNull(): ColumnDef;
  default(value: string): ColumnDef;
  /** @internal */
  _def: ColumnDefInternal;
}

function createColumnDef(type: SqliteType): ColumnDef {
  const def: ColumnDefInternal = {
    type,
    isNotNull: false,
    defaultValue: null,
  };

  const columnDef: ColumnDef = {
    _def: def,
    notNull() {
      def.isNotNull = true;
      return columnDef;
    },
    default(value: string) {
      def.defaultValue = value;
      return columnDef;
    },
  };

  return columnDef;
}

/**
 * Column builder - creates column definitions.
 * Only SQLite types: text, integer, real, blob.
 */
export interface ColumnBuilder {
  text(): ColumnDef;
  integer(): ColumnDef;
  real(): ColumnDef;
  blob(): ColumnDef;
}

const columnBuilder: ColumnBuilder = {
  text: () => createColumnDef('TEXT'),
  integer: () => createColumnDef('INTEGER'),
  real: () => createColumnDef('REAL'),
  blob: () => createColumnDef('BLOB'),
};

// ----------------------------------------------------------------------------
// Table Types
// ----------------------------------------------------------------------------

/**
 * Auto-generated columns added to every table.
 */
interface AutoColumns {
  id: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * Table reference - carries type information for column names.
 */
export interface Table<T> {
  readonly _name: string;
  readonly _phantom?: T;
}

/**
 * Table with SQL statements (from defineTable).
 */
export interface DefinedTable<T> extends Table<T> {
  readonly sql: string[];
}

// ----------------------------------------------------------------------------
// Table Definition
// ----------------------------------------------------------------------------

type TableDefFn<T extends Record<string, ColumnDef>> = (col: ColumnBuilder) => T;

/**
 * Define a table with auto-generated id, createdAt, updatedAt columns.
 * Returns a Table object with sql property containing CREATE TABLE + CREATE TRIGGER.
 */
export function defineTable<T extends Record<string, ColumnDef>>(
  name: string,
  fn: TableDefFn<T>
): DefinedTable<{ [K in keyof T]: unknown } & AutoColumns> {
  const columns = fn(columnBuilder);
  const columnDefs: string[] = [];

  // Auto id column
  columnDefs.push(`  "id" INTEGER PRIMARY KEY AUTOINCREMENT`);

  // User-defined columns
  for (const [colName, colDef] of Object.entries(columns)) {
    let sql = `  "${colName}" ${colDef._def.type}`;
    if (colDef._def.isNotNull) {
      sql += ' NOT NULL';
    }
    if (colDef._def.defaultValue !== null) {
      sql += ` DEFAULT ${colDef._def.defaultValue}`;
    }
    columnDefs.push(sql);
  }

  // Auto timestamp columns
  columnDefs.push(`  "createdAt" TEXT NOT NULL DEFAULT (datetime('now'))`);
  columnDefs.push(`  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))`);

  const createTableSql = `CREATE TABLE "${name}" (\n${columnDefs.join(',\n')}\n);`;

  const createTriggerSql = `CREATE TRIGGER "${name}_updatedAt"
AFTER UPDATE ON "${name}"
FOR EACH ROW
BEGIN
  UPDATE "${name}" SET "updatedAt" = datetime('now') WHERE "id" = NEW."id";
END;`;

  return {
    _name: name,
    sql: [createTableSql, createTriggerSql],
  };
}

/**
 * Reference an existing table for type-safe operations.
 * Use with kysely-codegen types: useTable<DB['Place']>('Place')
 */
export function useTable<T>(name: string): Table<T> {
  return { _name: name };
}

/**
 * Create a typed useTable function for your database schema.
 * Setup once, use everywhere with full type inference.
 *
 * @example
 * ```typescript
 * // db/index.ts - create once
 * import type { DB } from './generated';
 * import { createUseTable } from 'd1-kyt/migrate';
 *
 * export const useTable = createUseTable<DB>();
 *
 * // migrations - use with inference
 * const Place = useTable('Place');  // Table<DB['Place']>
 * const City = useTable('City');    // Table<DB['City']>
 * ```
 */
export function createUseTable<DB>() {
  return function <K extends keyof DB & string>(name: K): Table<DB[K]> {
    return { _name: name };
  };
}

// ----------------------------------------------------------------------------
// Index Operations
// ----------------------------------------------------------------------------

interface IndexOptions {
  unique?: boolean;
  name?: string;
}

/**
 * Create an index on a table.
 * Use { unique: true } for unique constraint.
 * Use { name: 'custom_name' } to override auto-generated name.
 */
export function createIndex<T>(
  table: Table<T>,
  columns: (keyof T & string)[],
  options?: IndexOptions
): string {
  const tableName = table._name;
  const unique = options?.unique ?? false;
  const suffix = unique ? 'unique' : 'idx';
  const indexName = options?.name ?? `${tableName}_${columns.join('_')}_${suffix}`;
  const columnList = columns.map((c) => `"${c}"`).join(', ');
  const uniqueKeyword = unique ? 'UNIQUE ' : '';

  return `CREATE ${uniqueKeyword}INDEX "${indexName}" ON "${tableName}"(${columnList});`;
}

/**
 * Drop an index by name.
 */
export function dropIndex(name: string): string {
  return `DROP INDEX "${name}";`;
}

// ----------------------------------------------------------------------------
// Column Operations
// ----------------------------------------------------------------------------

/**
 * Add a column to an existing table.
 * Column name is type-checked against table columns.
 */
export function addColumn<T, K extends string>(
  table: Table<T>,
  column: K,
  fn: (col: ColumnBuilder) => ColumnDef
): string {
  const colDef = fn(columnBuilder);
  let sql = `ALTER TABLE "${table._name}" ADD COLUMN "${column}" ${colDef._def.type}`;
  if (colDef._def.isNotNull) {
    sql += ' NOT NULL';
  }
  if (colDef._def.defaultValue !== null) {
    sql += ` DEFAULT ${colDef._def.defaultValue}`;
  }
  return sql + ';';
}

// ----------------------------------------------------------------------------
// Table Operations
// ----------------------------------------------------------------------------

/**
 * Drop a table and its updatedAt trigger.
 */
export function dropTable<T>(table: Table<T>): string[] {
  const name = table._name;
  return [
    `DROP TABLE "${name}";`,
    `DROP TRIGGER IF EXISTS "${name}_updatedAt";`,
  ];
}
