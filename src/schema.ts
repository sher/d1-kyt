/**
 * Declarative schema API for d1-kyt.
 * Define tables using Valibot schemas as column types.
 * Use `d1-kyt schema:diff <name>` to generate migration SQL from schema diffs.
 */

import type * as v from 'valibot';
import type { ColumnType, Generated } from 'kysely';
import type { TableOptions } from './migrate.js';

export type { TableOptions };

// ----------------------------------------------------------------------------
// SQLite Type
// ----------------------------------------------------------------------------

export type SqliteType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

// ----------------------------------------------------------------------------
// Schema Object Types
// ----------------------------------------------------------------------------

export interface SchemaIndex {
  readonly _tableName: string;
  readonly name: string;
  readonly columns: string[];
  readonly unique: boolean;
  readonly where?: string;
}

export interface SchemaForeignKey {
  readonly columns: string[];
  readonly references: SchemaTable<any, any>;
  readonly refColumns?: string[];
  readonly onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  readonly onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

export interface SchemaTrigger {
  readonly name: string;
  readonly timing: 'BEFORE' | 'AFTER';
  readonly event: 'INSERT' | 'UPDATE' | 'DELETE';
  readonly tableName: string;
  readonly body: string;
}

// ----------------------------------------------------------------------------
// withDefault
// ----------------------------------------------------------------------------

/**
 * Mark a column as having a database-level DEFAULT value.
 * The column stays NOT NULL. The value is emitted as SQL DEFAULT.
 * On INSERT the column is optional; on SELECT it is always present.
 *
 * @example
 * ```ts
 * active: withDefault(v.boolean(), false)                    // INTEGER NOT NULL DEFAULT 0
 * role:   withDefault(v.string(), 'viewer')                  // TEXT NOT NULL DEFAULT 'viewer'
 * score:  withDefault(v.pipe(v.number(), v.integer()), 0)    // INTEGER NOT NULL DEFAULT 0
 * ```
 */
export interface WithDefault<S extends v.BaseSchema<any, any, any>, D> {
  readonly _tag: 'withDefault';
  readonly schema: S;
  readonly value: D;
}

export function withDefault<
  S extends v.BaseSchema<any, any, any>,
  D extends v.InferOutput<S>,
>(schema: S, value: D): WithDefault<S, D> {
  return { _tag: 'withDefault', schema, value };
}

/**
 * A column schema: either a plain Valibot schema or a withDefault wrapper.
 */
export type AnyColSchema =
  | v.BaseSchema<any, any, any>
  | WithDefault<v.BaseSchema<any, any, any>, any>;

// ----------------------------------------------------------------------------
// Type Inference
// ----------------------------------------------------------------------------

type PkColName<O extends TableOptions> = O['primaryKeyColumn'] extends string
  ? O['primaryKeyColumn']
  : 'id';

type CreatedColName<O extends TableOptions> = O['createdAtColumn'] extends string
  ? O['createdAtColumn']
  : 'createdAt';

type UpdatedColName<O extends TableOptions> = O['updatedAtColumn'] extends string
  ? O['updatedAtColumn']
  : 'updatedAt';

type AutoColumnsSelect<O extends TableOptions> =
  (O['primaryKey'] extends false ? object : { [K in PkColName<O>]: number }) &
  (O['createdAt'] extends false ? object : { [K in CreatedColName<O>]: string }) &
  (O['updatedAt'] extends false ? object : { [K in UpdatedColName<O>]: string });

type AutoColumnsKysely<O extends TableOptions> =
  (O['primaryKey'] extends false ? object : { [K in PkColName<O>]: Generated<number> }) &
  (O['createdAt'] extends false ? object : { [K in CreatedColName<O>]: Generated<string> }) &
  (O['updatedAt'] extends false ? object : { [K in UpdatedColName<O>]: Generated<string> });

// Detect object/array (JSON) types vs primitives. Tuple wrapping prevents
// distributive behavior: [string | object] extends [object] is false.
type IsJsonOutput<T> =
  [T] extends [string | number | boolean | null | undefined] ? false :
  [T] extends [object] ? true :
  false;

// Extract the TypeScript output type from any column schema.
type ColOutput<S extends AnyColSchema> =
  S extends WithDefault<infer Inner extends v.BaseSchema<any, any, any>, any>
    ? v.InferOutput<Inner>
    : S extends v.BaseSchema<any, any, any>
      ? v.InferOutput<S>
      : never;

// True when the column may be omitted on INSERT.
type IsInsertOptional<S extends AnyColSchema> =
  S extends WithDefault<any, any>
    ? true
    : S extends { type: 'nullable' }
      ? true
      : false;

// Map a single column schema to its Kysely column type.
type InferKyselyColumn<S extends AnyColSchema> =
  S extends WithDefault<infer Inner extends v.BaseSchema<any, any, any>, any>
    ? IsJsonOutput<v.InferOutput<Inner>> extends true
      ? ColumnType<v.InferOutput<Inner>, v.InferOutput<Inner> | undefined, v.InferOutput<Inner>>
      : Generated<v.InferOutput<Inner>>
    : S extends { type: 'nullable'; wrapped: infer Inner extends v.BaseSchema<any, any, any> }
      ? v.InferOutput<Inner> | null
      : S extends v.BaseSchema<any, any, any>
        ? IsJsonOutput<v.InferOutput<S>> extends true
          ? ColumnType<v.InferOutput<S>, v.InferOutput<S>, v.InferOutput<S>>
          : v.InferOutput<S>
        : never;

/**
 * Infer a Kysely-compatible DB type from a record of SchemaTable definitions.
 * Columns wrapped with withDefault become Generated<T> (optional on insert).
 * JSON columns use ColumnType<T, T, T>.
 *
 * @example
 * export type DB = InferDB<{ Match: typeof Match }>;
 * export const db = createQueryBuilder<DB>();
 */
export type InferDB<Tables extends Record<string, SchemaTable<any, any>>> = {
  [K in keyof Tables]: {
    [C in keyof Tables[K]['_columns']]: InferKyselyColumn<Tables[K]['_columns'][C]>;
  } & AutoColumnsKysely<Tables[K]['_options']>;
};

type InferSelect<
  Cols extends Record<string, AnyColSchema>,
  O extends TableOptions = object,
> = {
  [K in keyof Cols]: ColOutput<Cols[K]>;
} & AutoColumnsSelect<O>;

type InferInsert<Cols extends Record<string, AnyColSchema>> = {
  [K in keyof Cols as IsInsertOptional<Cols[K]> extends true ? never : K]: ColOutput<Cols[K]>;
} & {
  [K in keyof Cols as IsInsertOptional<Cols[K]> extends true ? K : never]?: ColOutput<Cols[K]>;
} & { id?: number; createdAt?: string; updatedAt?: string };

// ----------------------------------------------------------------------------
// SchemaTable Interface
// ----------------------------------------------------------------------------

export interface SchemaTable<
  Cols extends Record<string, AnyColSchema> = Record<string, AnyColSchema>,
  O extends TableOptions = object,
> {
  readonly _name: string;
  readonly _columns: Cols;
  readonly _options: O;
  readonly _indexes: SchemaIndex[];
  readonly _triggers: SchemaTrigger[];
  readonly _foreignKeys: SchemaForeignKey[];
  /** @internal runtime marker for schema detection */
  readonly _schemaTable: true;
  /** Phantom type: resolved row type for SELECT queries */
  $inferSelect: InferSelect<Cols, O>;
  /** Phantom type: input type for INSERT queries */
  $inferInsert: InferInsert<Cols>;
}

// ----------------------------------------------------------------------------
// Column Type Detection
// ----------------------------------------------------------------------------

export interface ColumnTypeInfo {
  type: SqliteType;
  notNull: boolean;
  default?: string;
  isJson: boolean;
  isBoolean: boolean;
}

/**
 * Inspect a column schema and derive the SQLite type, nullability,
 * and optional DEFAULT value.
 *
 * Mapping:
 *   v.string()                           → TEXT NOT NULL
 *   v.number()                           → REAL NOT NULL
 *   v.pipe(v.number(), v.integer(), ...) → INTEGER NOT NULL
 *   v.boolean()                          → INTEGER NOT NULL
 *   v.object({...}) / v.array(...)       → TEXT NOT NULL (JSON)
 *   v.nullable(X)                        → type of X, NULL
 *   withDefault(X, val)                  → type of X, NOT NULL DEFAULT val
 */
export function sqlTypeFromSchema(schema: AnyColSchema): ColumnTypeInfo {
  // Handle withDefault wrapper — extract default value, recurse on inner schema.
  if ((schema as any)._tag === 'withDefault') {
    const wd = schema as WithDefault<v.BaseSchema<any, any, any>, any>;
    const info = sqlTypeFromSchema(wd.schema);
    const def: unknown = wd.value;
    let defaultSql: string | undefined;
    if (def === null) {
      defaultSql = 'NULL';
    } else if (typeof def === 'string') {
      defaultSql = `'${def}'`;
    } else if (typeof def === 'number') {
      defaultSql = String(def);
    } else if (typeof def === 'boolean') {
      defaultSql = def ? '1' : '0';
    }
    return { ...info, default: defaultSql };
  }

  let nullable = false;
  let inner: any = schema;

  if (inner?.type === 'nullable') {
    nullable = true;
    inner = inner.wrapped;
  }

  // In Valibot v1, v.pipe(v.number(), v.integer()) produces an object where:
  //   .type === 'number'  AND  .pipe === [numberSchema, integerValidationAction]
  if (inner?.type === 'number' && Array.isArray(inner.pipe)) {
    const hasInteger = (inner.pipe as any[]).some(
      (item: any) => item.type === 'integer' && item.kind === 'validation',
    );
    if (hasInteger) {
      return { type: 'INTEGER', notNull: !nullable, default: undefined, isJson: false, isBoolean: false };
    }
  }

  const baseType: string = inner?.type ?? 'unknown';

  switch (baseType) {
    case 'string':
      return { type: 'TEXT', notNull: !nullable, default: undefined, isJson: false, isBoolean: false };
    case 'number':
      return { type: 'REAL', notNull: !nullable, default: undefined, isJson: false, isBoolean: false };
    case 'boolean':
      return { type: 'INTEGER', notNull: !nullable, default: undefined, isJson: false, isBoolean: true };
    case 'object':
    case 'array':
      return { type: 'TEXT', notNull: !nullable, default: undefined, isJson: true, isBoolean: false };
    default:
      return { type: 'TEXT', notNull: !nullable, default: undefined, isJson: false, isBoolean: false };
  }
}

// ----------------------------------------------------------------------------
// Table Registry
// ----------------------------------------------------------------------------

const tableRegistry = new Map<string, SchemaTable<any, any>>();

export function getTableRegistry(): ReadonlyMap<string, SchemaTable<any, any>> {
  return tableRegistry;
}

// ----------------------------------------------------------------------------
// defineTable
// ----------------------------------------------------------------------------

/**
 * Define a table using Valibot schemas as column types.
 * Use withDefault(schema, value) for columns with database-level defaults.
 * Use v.nullable(schema) for columns that allow NULL.
 *
 * Auto-columns (id, createdAt, updatedAt) are added by default; control via
 * the same `TableOptions` as the imperative `defineTable` in `d1-kyt/migrate`.
 *
 * @example
 * ```ts
 * import { defineTable, withDefault } from 'd1-kyt/schema';
 * import * as v from 'valibot';
 *
 * export const users = defineTable('users', {
 *   email: v.string(),
 *   name: v.nullable(v.string()),
 *   role: withDefault(v.string(), 'viewer'),
 * });
 * ```
 */
export function defineTable<
  Cols extends Record<string, AnyColSchema>,
  O extends TableOptions = object,
>(
  name: string,
  columns: Cols,
  options?: O & { foreignKeys?: Array<Omit<SchemaForeignKey, 'columns'> & { columns: (keyof Cols & string)[] }> },
): SchemaTable<Cols, O> {
  const table = {
    _name: name,
    _columns: columns,
    _options: (options ?? {}) as O,
    _indexes: [],
    _triggers: [],
    _foreignKeys: [...(options?.foreignKeys ?? [])],
    _schemaTable: true,
  } as unknown as SchemaTable<Cols, O>;
  tableRegistry.set(name, table);
  return table;
}

// ----------------------------------------------------------------------------
// defineIndex
// ----------------------------------------------------------------------------

/**
 * Define an index on a table.
 * Column names are type-checked against the table's column definitions.
 *
 * @example
 * ```ts
 * export const usersEmailIdx = defineIndex(users, ['email'], { unique: true });
 * ```
 */
export function defineIndex<Cols extends Record<string, AnyColSchema>>(
  table: SchemaTable<Cols, any>,
  columns: (keyof Cols & string)[],
  options?: { unique?: boolean; name?: string; where?: string },
): SchemaIndex {
  const unique = options?.unique ?? false;
  const suffix = unique ? 'uq' : 'idx';
  const name = options?.name ?? `${table._name}_${columns.join('_')}_${suffix}`;

  const index: SchemaIndex = {
    _tableName: table._name,
    name,
    columns: columns as string[],
    unique,
    where: options?.where,
  };

  (table._indexes as SchemaIndex[]).push(index);

  return index;
}

// ----------------------------------------------------------------------------
// defineTrigger
// ----------------------------------------------------------------------------

/**
 * Define a custom SQL trigger on a table.
 *
 * @example
 * ```ts
 * export const auditTrigger = defineTrigger('users_audit_trg', {
 *   timing: 'AFTER', event: 'INSERT', on: users,
 *   body: `INSERT INTO audit (action) VALUES ('insert');`,
 * });
 * ```
 */
export function defineTrigger(
  name: string,
  options: {
    timing: 'BEFORE' | 'AFTER';
    event: 'INSERT' | 'UPDATE' | 'DELETE';
    on: SchemaTable<any, any>;
    body: string;
  },
): SchemaTrigger {
  const trigger: SchemaTrigger = {
    name,
    timing: options.timing,
    event: options.event,
    tableName: options.on._name,
    body: options.body,
  };

  (options.on._triggers as SchemaTrigger[]).push(trigger);

  return trigger;
}
