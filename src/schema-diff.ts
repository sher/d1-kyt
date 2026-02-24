/**
 * Snapshot types, serializer, diff engine, and SQL generator for
 * the declarative schema workflow (schema:diff command).
 */

import type { SchemaTable, ColumnTypeInfo, TableOptions } from './schema.js';
import { sqlTypeFromSchema } from './schema.js';

// ----------------------------------------------------------------------------
// Snapshot Types
// ----------------------------------------------------------------------------

export type SqliteType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

export interface ColumnSnapshot {
  name: string;
  type: SqliteType;
  notNull: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  default?: string;
}

export interface IndexSnapshot {
  name: string;
  columns: string[];
  unique: boolean;
  where?: string;
}

export interface TriggerSnapshot {
  name: string;
  timing: string;
  event: string;
  tableName: string;
  body: string;
}

export interface TableSnapshot {
  name: string;
  columns: Record<string, ColumnSnapshot>;
  indexes: Record<string, IndexSnapshot>;
  triggers: Record<string, TriggerSnapshot>;
}

export interface SchemaSnapshot {
  version: 1;
  tables: Record<string, TableSnapshot>;
}

// ----------------------------------------------------------------------------
// Diff Types
// ----------------------------------------------------------------------------

export interface ColumnChange {
  name: string;
  before?: ColumnSnapshot;
  after?: ColumnSnapshot;
}

export interface IndexChange {
  name: string;
  before?: IndexSnapshot;
  after?: IndexSnapshot;
}

export interface TriggerChange {
  name: string;
  before?: TriggerSnapshot;
  after?: TriggerSnapshot;
}

export interface TableChange {
  name: string;
  columns: ColumnChange[];
  indexes: IndexChange[];
  triggers: TriggerChange[];
}

export interface SchemaDiff {
  addedTables: TableSnapshot[];
  droppedTables: TableSnapshot[];
  changedTables: TableChange[];
}

// ----------------------------------------------------------------------------
// Internal Helpers
// ----------------------------------------------------------------------------

/** Detect SchemaTable by its runtime marker property. */
function isSchemaTable(val: unknown): val is SchemaTable {
  return (
    typeof val === 'object' &&
    val !== null &&
    '_schemaTable' in val &&
    (val as Record<string, unknown>)._schemaTable === true
  );
}

const defaultOpts = {
  primaryKey: true,
  createdAt: true,
  updatedAt: true,
  primaryKeyColumn: 'id',
  createdAtColumn: 'createdAt',
  updatedAtColumn: 'updatedAt',
} as const;

// ----------------------------------------------------------------------------
// serializeSchema
// ----------------------------------------------------------------------------

/**
 * Convert a module's named exports into a SchemaSnapshot.
 * Only values produced by `defineTable` are included; everything else is skipped.
 */
export function serializeSchema(exports: Record<string, unknown>): SchemaSnapshot {
  const tables: Record<string, TableSnapshot> = {};

  for (const val of Object.values(exports)) {
    if (!isSchemaTable(val)) continue;

    const table = val as SchemaTable;
    const rawOpts = (table._options ?? {}) as TableOptions;
    const opts = { ...defaultOpts, ...rawOpts };

    const columns: Record<string, ColumnSnapshot> = {};

    // Auto: primary key column
    if (opts.primaryKey) {
      columns[opts.primaryKeyColumn] = {
        name: opts.primaryKeyColumn,
        type: 'INTEGER',
        notNull: true,
        primaryKey: true,
        autoIncrement: true,
      };
    }

    // User-defined columns (preserve definition order)
    for (const [colName, colSchema] of Object.entries(
      table._columns as Record<string, any>,
    )) {
      const info: ColumnTypeInfo = sqlTypeFromSchema(colSchema);
      const col: ColumnSnapshot = {
        name: colName,
        type: info.type,
        notNull: info.notNull,
      };
      if (info.default !== undefined) col.default = info.default;
      columns[colName] = col;
    }

    // Auto: createdAt column
    if (opts.createdAt) {
      columns[opts.createdAtColumn] = {
        name: opts.createdAtColumn,
        type: 'TEXT',
        notNull: true,
        default: `(datetime('now'))`,
      };
    }

    // Auto: updatedAt column
    if (opts.updatedAt) {
      columns[opts.updatedAtColumn] = {
        name: opts.updatedAtColumn,
        type: 'TEXT',
        notNull: true,
        default: `(datetime('now'))`,
      };
    }

    // Indexes
    const indexes: Record<string, IndexSnapshot> = {};
    for (const idx of table._indexes) {
      const snap: IndexSnapshot = {
        name: idx.name,
        columns: idx.columns,
        unique: idx.unique,
      };
      if (idx.where !== undefined) snap.where = idx.where;
      indexes[idx.name] = snap;
    }

    // Triggers: auto updatedAt trigger
    const triggers: Record<string, TriggerSnapshot> = {};
    if (opts.updatedAt) {
      const colKeys = Object.keys(table._columns as Record<string, unknown>);
      const pkCol = opts.primaryKey ? opts.primaryKeyColumn : colKeys[0];
      if (pkCol) {
        const trigName = `${table._name}_${opts.updatedAtColumn}_trg`;
        triggers[trigName] = {
          name: trigName,
          timing: 'AFTER',
          event: 'UPDATE',
          tableName: table._name,
          body: `UPDATE "${table._name}" SET "${opts.updatedAtColumn}" = datetime('now') WHERE "${pkCol}" = NEW."${pkCol}";`,
        };
      }
    }

    // User-defined triggers (appended after auto trigger)
    for (const trg of table._triggers) {
      triggers[trg.name] = {
        name: trg.name,
        timing: trg.timing,
        event: trg.event,
        tableName: trg.tableName,
        body: trg.body,
      };
    }

    tables[table._name] = {
      name: table._name,
      columns,
      indexes,
      triggers,
    };
  }

  return { version: 1, tables };
}

// ----------------------------------------------------------------------------
// diffSnapshots
// ----------------------------------------------------------------------------

/**
 * Compute the structural diff between two snapshots.
 * Returns added/dropped tables and per-table column/index/trigger changes.
 */
export function diffSnapshots(prev: SchemaSnapshot, next: SchemaSnapshot): SchemaDiff {
  const prevTables: Record<string, TableSnapshot> = prev?.tables ?? {};
  const nextTables: Record<string, TableSnapshot> = next?.tables ?? {};

  const addedTables: TableSnapshot[] = [];
  const droppedTables: TableSnapshot[] = [];
  const changedTables: TableChange[] = [];

  // Added tables
  for (const name of Object.keys(nextTables)) {
    if (!(name in prevTables)) {
      addedTables.push(nextTables[name]);
    }
  }

  // Dropped tables
  for (const name of Object.keys(prevTables)) {
    if (!(name in nextTables)) {
      droppedTables.push(prevTables[name]);
    }
  }

  // Changed tables (exist in both)
  for (const name of Object.keys(nextTables)) {
    if (!(name in prevTables)) continue;

    const prevTable = prevTables[name];
    const nextTable = nextTables[name];

    const columns: ColumnChange[] = [];
    const indexes: IndexChange[] = [];
    const triggers: TriggerChange[] = [];

    // Columns: added or modified
    for (const col of Object.values(nextTable.columns)) {
      if (!(col.name in prevTable.columns)) {
        columns.push({ name: col.name, after: col });
      } else {
        const prevCol = prevTable.columns[col.name];
        if (JSON.stringify(prevCol) !== JSON.stringify(col)) {
          columns.push({ name: col.name, before: prevCol, after: col });
        }
      }
    }

    // Columns: dropped
    for (const col of Object.values(prevTable.columns)) {
      if (!(col.name in nextTable.columns)) {
        columns.push({ name: col.name, before: col });
      }
    }

    // Indexes: added or modified
    for (const idx of Object.values(nextTable.indexes)) {
      if (!(idx.name in prevTable.indexes)) {
        indexes.push({ name: idx.name, after: idx });
      } else {
        const prevIdx = prevTable.indexes[idx.name];
        if (JSON.stringify(prevIdx) !== JSON.stringify(idx)) {
          indexes.push({ name: idx.name, before: prevIdx, after: idx });
        }
      }
    }

    // Indexes: dropped
    for (const idx of Object.values(prevTable.indexes)) {
      if (!(idx.name in nextTable.indexes)) {
        indexes.push({ name: idx.name, before: idx });
      }
    }

    // Triggers: added or modified
    for (const trg of Object.values(nextTable.triggers)) {
      if (!(trg.name in prevTable.triggers)) {
        triggers.push({ name: trg.name, after: trg });
      } else {
        const prevTrg = prevTable.triggers[trg.name];
        if (JSON.stringify(prevTrg) !== JSON.stringify(trg)) {
          triggers.push({ name: trg.name, before: prevTrg, after: trg });
        }
      }
    }

    // Triggers: dropped
    for (const trg of Object.values(prevTable.triggers)) {
      if (!(trg.name in nextTable.triggers)) {
        triggers.push({ name: trg.name, before: trg });
      }
    }

    if (columns.length > 0 || indexes.length > 0 || triggers.length > 0) {
      changedTables.push({ name, columns, indexes, triggers });
    }
  }

  return { addedTables, droppedTables, changedTables };
}

// ----------------------------------------------------------------------------
// SQL Generation
// ----------------------------------------------------------------------------

/** Render a column definition for use inside CREATE TABLE. */
function columnToSQL(col: ColumnSnapshot): string {
  let def = `  "${col.name}" ${col.type}`;
  if (col.primaryKey) {
    def += ' PRIMARY KEY';
    if (col.autoIncrement) def += ' AUTOINCREMENT';
  } else if (col.notNull) {
    def += ' NOT NULL';
  }
  if (col.default !== undefined) {
    def += ` DEFAULT ${col.default}`;
  }
  return def;
}

/** Render a CREATE INDEX statement. Table name is required (not in IndexSnapshot). */
function indexToSQL(tableName: string, idx: IndexSnapshot): string {
  const unique = idx.unique ? 'UNIQUE ' : '';
  const cols = idx.columns.map((c) => `"${c}"`).join(', ');
  let sql = `CREATE ${unique}INDEX "${idx.name}" ON "${tableName}"(${cols})`;
  if (idx.where) sql += ` WHERE ${idx.where}`;
  return sql + ';';
}

/** Render a CREATE TRIGGER statement. Table name comes from TriggerSnapshot.tableName. */
function triggerToSQL(trg: TriggerSnapshot): string {
  return (
    `CREATE TRIGGER "${trg.name}"\n` +
    `${trg.timing} ${trg.event} ON "${trg.tableName}"\n` +
    `FOR EACH ROW\n` +
    `BEGIN\n` +
    `  ${trg.body}\n` +
    `END;`
  );
}

/** Render full CREATE TABLE + indexes + triggers for a new table. */
function tableToCreateSQL(table: TableSnapshot): string[] {
  const statements: string[] = [];

  const colDefs = Object.values(table.columns).map(columnToSQL);
  statements.push(`CREATE TABLE "${table.name}" (\n${colDefs.join(',\n')}\n);`);

  for (const idx of Object.values(table.indexes)) {
    statements.push(indexToSQL(table.name, idx));
  }

  for (const trg of Object.values(table.triggers)) {
    statements.push(triggerToSQL(trg));
  }

  return statements;
}

/**
 * Convert a SchemaDiff to an ordered list of SQL statements.
 *
 * - Added table   → CREATE TABLE + indexes + triggers
 * - Dropped table → warning comment + DROP TABLE
 * - Added column  → ALTER TABLE ADD COLUMN
 * - Dropped column → ALTER TABLE DROP COLUMN
 * - Modified column → warning comment (SQLite cannot ALTER COLUMN)
 * - Added/dropped index → CREATE INDEX / DROP INDEX
 * - Added/dropped trigger → CREATE TRIGGER / DROP TRIGGER
 */
export function diffToSQL(diff: SchemaDiff): string[] {
  const statements: string[] = [];

  // New tables
  for (const table of diff.addedTables) {
    statements.push(...tableToCreateSQL(table));
  }

  // Dropped tables
  for (const table of diff.droppedTables) {
    statements.push(`-- WARNING: data will be lost`);
    statements.push(`DROP TABLE "${table.name}";`);
  }

  // Changed tables
  for (const change of diff.changedTables) {
    // Columns
    for (const col of change.columns) {
      if (!col.before && col.after) {
        // Added column
        let sql = `ALTER TABLE "${change.name}" ADD COLUMN "${col.after.name}" ${col.after.type}`;
        if (col.after.notNull) sql += ' NOT NULL';
        if (col.after.default !== undefined) sql += ` DEFAULT ${col.after.default}`;
        statements.push(sql + ';');
      } else if (col.before && !col.after) {
        // Dropped column
        statements.push(`ALTER TABLE "${change.name}" DROP COLUMN "${col.name}";`);
      } else if (col.before && col.after) {
        // Modified column — SQLite does not support ALTER COLUMN
        statements.push(
          `-- WARNING: column "${change.name}"."${col.name}" changed; SQLite cannot ALTER COLUMN — handle manually`,
        );
      }
    }

    // Indexes
    for (const idx of change.indexes) {
      if (!idx.before && idx.after) {
        statements.push(indexToSQL(change.name, idx.after));
      } else if (idx.before && !idx.after) {
        statements.push(`DROP INDEX "${idx.name}";`);
      } else if (idx.before && idx.after) {
        // Changed index: drop and recreate
        statements.push(`DROP INDEX "${idx.name}";`);
        statements.push(indexToSQL(change.name, idx.after));
      }
    }

    // Triggers
    for (const trg of change.triggers) {
      if (!trg.before && trg.after) {
        statements.push(triggerToSQL(trg.after));
      } else if (trg.before && !trg.after) {
        statements.push(`DROP TRIGGER IF EXISTS "${trg.name}";`);
      } else if (trg.before && trg.after) {
        // Changed trigger: drop and recreate
        statements.push(`DROP TRIGGER IF EXISTS "${trg.name}";`);
        statements.push(triggerToSQL(trg.after));
      }
    }
  }

  return statements;
}

