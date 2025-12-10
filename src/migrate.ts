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
// Table Options
// ----------------------------------------------------------------------------

/**
 * Options for auto-generated columns in defineTable.
 * All options default to true for backwards compatibility.
 */
export interface TableOptions {
  /** Add "id" INTEGER PRIMARY KEY AUTOINCREMENT column. Default: true */
  id?: boolean;
  /** Add "createdAt" TEXT column with default datetime('now'). Default: true */
  createdAt?: boolean;
  /** Add "updatedAt" TEXT column with trigger. Default: true */
  updatedAt?: boolean;
  /** Custom name for id column. Default: "id" */
  idColumn?: string;
  /** Custom name for createdAt column. Default: "createdAt" */
  createdAtColumn?: string;
  /** Custom name for updatedAt column. Default: "updatedAt" */
  updatedAtColumn?: string;
}

// ----------------------------------------------------------------------------
// Table Types
// ----------------------------------------------------------------------------

/**
 * Auto-generated columns - conditional based on options.
 */
type AutoColumns<
  O extends TableOptions,
  IdCol extends string = O['idColumn'] extends string ? O['idColumn'] : 'id',
  CreatedCol extends string = O['createdAtColumn'] extends string ? O['createdAtColumn'] : 'createdAt',
  UpdatedCol extends string = O['updatedAtColumn'] extends string ? O['updatedAtColumn'] : 'updatedAt',
> = (O['id'] extends false ? {} : { [K in IdCol]: unknown }) &
  (O['createdAt'] extends false ? {} : { [K in CreatedCol]: unknown }) &
  (O['updatedAt'] extends false ? {} : { [K in UpdatedCol]: unknown });

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

/** Default options for defineTable */
const defaultTableOptions: Required<TableOptions> = {
  id: true,
  createdAt: true,
  updatedAt: true,
  idColumn: 'id',
  createdAtColumn: 'createdAt',
  updatedAtColumn: 'updatedAt',
};

/**
 * Define a table with configurable auto-generated columns.
 * By default adds id, createdAt, updatedAt columns.
 * Returns a Table object with sql property containing CREATE TABLE + optional CREATE TRIGGER.
 */
export function defineTable<T extends Record<string, ColumnDef>, O extends TableOptions = {}>(
  name: string,
  fn: TableDefFn<T>,
  options?: O
): DefinedTable<{ [K in keyof T]: unknown } & AutoColumns<O>> {
  const opts = { ...defaultTableOptions, ...options };
  const columns = fn(columnBuilder);
  const columnDefs: string[] = [];
  const sqlStatements: string[] = [];

  // Auto id column
  if (opts.id) {
    columnDefs.push(`  "${opts.idColumn}" INTEGER PRIMARY KEY AUTOINCREMENT`);
  }

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
  if (opts.createdAt) {
    columnDefs.push(`  "${opts.createdAtColumn}" TEXT NOT NULL DEFAULT (datetime('now'))`);
  }
  if (opts.updatedAt) {
    columnDefs.push(`  "${opts.updatedAtColumn}" TEXT NOT NULL DEFAULT (datetime('now'))`);
  }

  const createTableSql = `CREATE TABLE "${name}" (\n${columnDefs.join(',\n')}\n);`;
  sqlStatements.push(createTableSql);

  // Only create trigger if updatedAt is enabled
  if (opts.updatedAt) {
    // Determine primary key column for WHERE clause
    const pkColumn = opts.id ? opts.idColumn : findPrimaryKeyColumn(columns);
    if (pkColumn) {
      const createTriggerSql = `CREATE TRIGGER "${name}_${opts.updatedAtColumn}_trg"
AFTER UPDATE ON "${name}"
FOR EACH ROW
BEGIN
  UPDATE "${name}" SET "${opts.updatedAtColumn}" = datetime('now') WHERE "${pkColumn}" = NEW."${pkColumn}";
END;`;
      sqlStatements.push(createTriggerSql);
    }
  }

  return {
    _name: name,
    sql: sqlStatements,
  } as DefinedTable<{ [K in keyof T]: unknown } & AutoColumns<O>>;
}

/**
 * Find a column that could serve as primary key (first column if no id).
 * Returns null if no suitable column found.
 */
function findPrimaryKeyColumn(columns: Record<string, ColumnDef>): string | null {
  const keys = Object.keys(columns);
  return keys.length > 0 ? keys[0] : null;
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
  const suffix = unique ? 'uq' : 'idx';
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
 * @param updatedAtColumn - Custom updatedAt column name if using custom naming. Default: "updatedAt"
 */
export function dropTable<T>(table: Table<T>, updatedAtColumn: string = 'updatedAt'): string[] {
  const name = table._name;
  return [
    `DROP TABLE "${name}";`,
    `DROP TRIGGER IF EXISTS "${name}_${updatedAtColumn}_trg";`,
  ];
}
