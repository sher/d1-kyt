/**
 * Snapshot types, serializer, diff engine, and SQL generator for
 * the declarative schema workflow (schema:diff command).
 */

import type { SchemaTable, ColumnTypeInfo, TableOptions, SchemaForeignKey } from './schema.js';
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

export interface ForeignKeySnapshot {
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface TableSnapshot {
  name: string;
  columns: Record<string, ColumnSnapshot>;
  indexes: Record<string, IndexSnapshot>;
  triggers: Record<string, TriggerSnapshot>;
  foreignKeys: Record<string, ForeignKeySnapshot>;
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

export interface ForeignKeyChange {
  key: string;
  before?: ForeignKeySnapshot;
  after?: ForeignKeySnapshot;
}

export interface TableChange {
  name: string;
  prevTable: TableSnapshot;
  nextTable: TableSnapshot;
  columns: ColumnChange[];
  indexes: IndexChange[];
  triggers: TriggerChange[];
  foreignKeys: ForeignKeyChange[];
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

    // Foreign keys
    const foreignKeys: Record<string, ForeignKeySnapshot> = {};
    for (const fk of (table._foreignKeys ?? []) as SchemaForeignKey[]) {
      const refOpts = { ...defaultOpts, ...((fk.references._options ?? {}) as TableOptions) };
      const refPk = refOpts.primaryKey !== false ? refOpts.primaryKeyColumn : undefined;
      const refColumns = fk.refColumns ?? (refPk ? [refPk] : []);
      if (refColumns.length === 0) continue;
      const key = fk.columns.join(',');
      const snap: ForeignKeySnapshot = {
        columns: fk.columns,
        refTable: fk.references._name,
        refColumns,
      };
      if (fk.onDelete) snap.onDelete = fk.onDelete;
      if (fk.onUpdate) snap.onUpdate = fk.onUpdate;
      foreignKeys[key] = snap;
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
      foreignKeys,
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
    const foreignKeys: ForeignKeyChange[] = [];

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

    // Foreign keys: added or modified
    const prevFks = prevTable.foreignKeys ?? {};
    const nextFks = nextTable.foreignKeys ?? {};
    for (const [key, fk] of Object.entries(nextFks)) {
      if (!(key in prevFks)) {
        foreignKeys.push({ key, after: fk });
      } else {
        const prevFk = prevFks[key];
        if (JSON.stringify(prevFk) !== JSON.stringify(fk)) {
          foreignKeys.push({ key, before: prevFk, after: fk });
        }
      }
    }

    // Foreign keys: dropped
    for (const [key, fk] of Object.entries(prevFks)) {
      if (!(key in nextFks)) {
        foreignKeys.push({ key, before: fk });
      }
    }

    if (columns.length > 0 || indexes.length > 0 || triggers.length > 0 || foreignKeys.length > 0) {
      changedTables.push({ name, prevTable, nextTable, columns, indexes, triggers, foreignKeys });
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

/** Render a FOREIGN KEY table constraint. */
function foreignKeyConstraintSQL(fk: ForeignKeySnapshot): string {
  const cols = fk.columns.map((c) => `"${c}"`).join(', ');
  const refCols = fk.refColumns.map((c) => `"${c}"`).join(', ');
  let def = `  FOREIGN KEY (${cols}) REFERENCES "${fk.refTable}"(${refCols})`;
  if (fk.onDelete) def += ` ON DELETE ${fk.onDelete}`;
  if (fk.onUpdate) def += ` ON UPDATE ${fk.onUpdate}`;
  return def;
}

/** Render full CREATE TABLE + indexes + triggers for a new table. */
function tableToCreateSQL(table: TableSnapshot): string[] {
  const statements: string[] = [];

  const colDefs = Object.values(table.columns).map(columnToSQL);
  const fkDefs = Object.values(table.foreignKeys ?? {}).map(foreignKeyConstraintSQL);
  const allDefs = [...colDefs, ...fkDefs];
  statements.push(`CREATE TABLE "${table.name}" (\n${allDefs.join(',\n')}\n);`);

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
 *
 * @param chunkSize Rows per INSERT chunk during table recreation (default 5000).
 *   Set to 0 to emit a single INSERT instead. Increase if you hit D1 timeouts.
 */
export function diffToSQL(diff: SchemaDiff, chunkSize = 5000): string[] {
  const statements: string[] = [];
  let hasForeignKeys = false;

  // New tables
  for (const table of diff.addedTables) {
    if (Object.keys(table.foreignKeys ?? {}).length > 0) hasForeignKeys = true;
    statements.push(...tableToCreateSQL(table));
  }

  // Dropped tables
  for (const table of diff.droppedTables) {
    statements.push(`-- WARNING: data will be lost`);
    statements.push(`DROP TABLE "${table.name}";`);
  }

  // Changed tables
  for (const change of diff.changedTables) {
    const handledFkKeys = new Set<string>();

    // Detect dropped columns that need table recreation (PK or unique-index constrained)
    const droppedCols = change.columns.filter((c) => c.before && !c.after);
    const constrainedDrops = droppedCols.filter(
      (col) =>
        col.before!.primaryKey === true ||
        change.indexes.some((idx) => idx.before?.unique && idx.before.columns.includes(col.name)),
    );
    const needsRecreation = constrainedDrops.length > 0;

    if (needsRecreation) {
      const { nextTable, prevTable } = change;

      // Warning + comment for each constrained drop
      statements.push(
        `-- WARNING: table "${change.name}" must be recreated (constrained column drop).` +
          ` Data is copied in ${chunkSize > 0 ? `chunks of ${chunkSize} rows` : 'a single statement'}.` +
          ` Large tables may exceed D1 execution limits — increase chunk size or split manually if needed.`,
      );
      for (const col of constrainedDrops) {
        statements.push(
          `-- Cannot DROP COLUMN "${col.name}" (PRIMARY KEY or UNIQUE constraint); recreate table instead`,
        );
      }

      // CREATE TABLE "<name>_new"
      const newName = `${change.name}_new`;
      const colDefs = Object.values(nextTable.columns).map(columnToSQL);
      const fkDefs = Object.values(nextTable.foreignKeys ?? {}).map(foreignKeyConstraintSQL);
      const allDefs = [...colDefs, ...fkDefs];
      statements.push(`CREATE TABLE "${newName}" (\n${allDefs.join(',\n')}\n);`);

      if (Object.keys(nextTable.foreignKeys ?? {}).length > 0) hasForeignKeys = true;

      // INSERT surviving columns — chunked by rowid range to stay within D1 limits
      const droppedColNames = new Set(droppedCols.map((c) => c.name));
      const survivingCols = Object.keys(prevTable.columns).filter((n) => !droppedColNames.has(n));
      const colList = survivingCols.map((n) => `"${n}"`).join(', ');

      if (chunkSize <= 0) {
        statements.push(`INSERT INTO "${newName}" SELECT ${colList} FROM "${change.name}";`);
      } else {
        const CHUNKS = 10;
        for (let i = 0; i < CHUNKS; i++) {
          const lo = i * chunkSize + 1;
          const hi = (i + 1) * chunkSize;
          statements.push(
            `INSERT INTO "${newName}" SELECT ${colList} FROM "${change.name}" WHERE rowid BETWEEN ${lo} AND ${hi};`,
          );
        }
        statements.push(
          `-- If "${change.name}" has more than ${CHUNKS * chunkSize} rows, add more INSERT statements following the same pattern (BETWEEN ${CHUNKS * chunkSize + 1} AND ${(CHUNKS + 1) * chunkSize}, etc.)`,
        );
      }

      // DROP old table and rename new
      statements.push(`DROP TABLE "${change.name}";`);
      statements.push(`ALTER TABLE "${newName}" RENAME TO "${change.name}";`);

      // Re-create all indexes from nextTable
      for (const idx of Object.values(nextTable.indexes)) {
        statements.push(indexToSQL(change.name, idx));
      }

      // Re-create all triggers from nextTable
      for (const trg of Object.values(nextTable.triggers)) {
        statements.push(triggerToSQL(trg));
      }
    }

    // Columns
    for (const col of change.columns) {
      if (!col.before && col.after) {
        // Added column — check for a new single-column inline FK
        let sql = `ALTER TABLE "${change.name}" ADD COLUMN "${col.after.name}" ${col.after.type}`;
        if (col.after.notNull) sql += ' NOT NULL';
        if (col.after.default !== undefined) sql += ` DEFAULT ${col.after.default}`;

        const inlineFk = change.foreignKeys.find(
          (fkc) =>
            !fkc.before &&
            fkc.after?.columns.length === 1 &&
            fkc.after.columns[0] === col.after!.name,
        );
        if (inlineFk?.after) {
          if (col.after.notNull) {
            statements.push(
              `-- WARNING: cannot add NOT NULL column "${col.after.name}" with FK to existing table "${change.name}"; make it nullable or rebuild the table`,
            );
          } else {
            const fk = inlineFk.after;
            sql += ` REFERENCES "${fk.refTable}"("${fk.refColumns[0]}")`;
            if (fk.onDelete) sql += ` ON DELETE ${fk.onDelete}`;
            if (fk.onUpdate) sql += ` ON UPDATE ${fk.onUpdate}`;
            handledFkKeys.add(inlineFk.key);
            hasForeignKeys = true;
          }
        }

        statements.push(sql + ';');
      } else if (col.before && !col.after) {
        // Dropped column — skip if handled by table recreation above
        if (!needsRecreation) {
          statements.push(`ALTER TABLE "${change.name}" DROP COLUMN "${col.name}";`);
        }
      } else if (col.before && col.after) {
        // Modified column — SQLite does not support ALTER COLUMN
        statements.push(
          `-- WARNING: column "${change.name}"."${col.name}" changed; SQLite cannot ALTER COLUMN — handle manually`,
        );
      }
    }

    // Indexes — skip when recreation already emitted all indexes
    if (!needsRecreation) {
      for (const idx of change.indexes) {
        if (!idx.before && idx.after) {
          statements.push(indexToSQL(change.name, idx.after));
        } else if (idx.before && !idx.after) {
          statements.push(`DROP INDEX IF EXISTS "${idx.name}";`);
        } else if (idx.before && idx.after) {
          // Changed index: drop and recreate
          statements.push(`DROP INDEX IF EXISTS "${idx.name}";`);
          statements.push(indexToSQL(change.name, idx.after));
        }
      }
    }

    // Triggers — skip when recreation already emitted all triggers
    if (!needsRecreation) {
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

    // Foreign keys not already handled inline
    for (const fkc of change.foreignKeys) {
      if (handledFkKeys.has(fkc.key)) continue;
      const cols = (fkc.after ?? fkc.before)!.columns.join(', ');
      const ref = (fkc.after ?? fkc.before)!;
      statements.push(
        `-- WARNING: cannot ${fkc.before && fkc.after ? 'modify' : fkc.before ? 'drop' : 'add'} FK (${cols}) → "${ref.refTable}" on existing table "${change.name}"; SQLite requires a table rebuild`,
      );
    }
  }

  if (hasForeignKeys) {
    statements.unshift('PRAGMA foreign_keys = ON;');
  }

  return statements;
}

