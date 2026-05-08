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

// Map a single valibot schema to its Kysely column type.
type InferKyselyColumn<S extends v.BaseSchema<any, any, any>> =
  S extends { type: 'optional'; wrapped: infer Inner extends v.BaseSchema<any, any, any>; default: infer Default }
    ? IsJsonOutput<v.InferOutput<Inner>> extends true
      ? Default extends undefined
        ? ColumnType<v.InferOutput<Inner> | null, v.InferOutput<Inner> | null | undefined, v.InferOutput<Inner> | null | undefined>
        : ColumnType<v.InferOutput<Inner>, v.InferOutput<Inner> | undefined, v.InferOutput<Inner>>
      : Default extends undefined
        ? Generated<v.InferOutput<Inner> | null>
        : Generated<v.InferOutput<Inner>>
    : S extends { type: 'nullable'; wrapped: infer Inner extends v.BaseSchema<any, any, any> }
      ? v.InferOutput<Inner> | null
      : IsJsonOutput<v.InferOutput<S>> extends true
        ? ColumnType<v.InferOutput<S>, v.InferOutput<S>, v.InferOutput<S>>
        : v.InferOutput<S>;

/**
 * Infer a Kysely-compatible DB type from a record of SchemaTable definitions.
 * Columns with defaults or auto-columns become `Generated<T>` (optional on insert).
 * JSON columns (object/array schemas) use `ColumnType<T, string, string>`.
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
  Cols extends Record<string, v.BaseSchema<any, any, any>>,
  O extends TableOptions = object,
> = {
  [K in keyof Cols]: v.InferOutput<Cols[K]>;
} & AutoColumnsSelect<O>;

type InferInsert<
  Cols extends Record<string, v.BaseSchema<any, any, any>>,
> = {
  [K in keyof Cols as undefined extends v.InferOutput<Cols[K]> ? never : K]: v.InferOutput<Cols[K]>;
} & {
  [K in keyof Cols as undefined extends v.InferOutput<Cols[K]> ? K : never]?: v.InferOutput<Cols[K]>;
} & { id?: number; createdAt?: string; updatedAt?: string };

// ----------------------------------------------------------------------------
// SchemaTable Interface
// ----------------------------------------------------------------------------

export interface SchemaTable<
  Cols extends Record<string, v.BaseSchema<any, any, any>> = Record<
    string,
    v.BaseSchema<any, any, any>
  >,
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
 * Inspect a Valibot schema object and derive the SQLite type, nullability,
 * and optional DEFAULT value.
 *
 * Mapping:
 *   v.string()                           → TEXT NOT NULL
 *   v.number()                           → REAL NOT NULL
 *   v.pipe(v.number(), v.integer(), ...) → INTEGER NOT NULL
 *   v.boolean()                          → INTEGER NOT NULL
 *   v.object({...}) / v.array(...)       → TEXT NOT NULL (JSON)
 *   v.optional(X) / v.nullable(X)       → type of X, nullable
 *   v.optional(X, defaultVal)           → type of X + DEFAULT, nullable
 */
export function sqlTypeFromSchema(schema: v.BaseSchema<any, any, any>): ColumnTypeInfo {
  let nullable = false;
  let defaultSql: string | undefined;
  let inner: any = schema;

  // Unwrap optional / nullable
  if (inner?.type === 'optional' || inner?.type === 'nullable') {
    nullable = true;
    if (inner.type === 'optional' && inner.default !== undefined) {
      const def: unknown =
        typeof inner.default === 'function' ? (inner.default as () => unknown)() : inner.default;
      if (typeof def === 'string') {
        defaultSql = `'${def}'`;
      } else if (typeof def === 'number') {
        defaultSql = String(def);
      } else if (typeof def === 'boolean') {
        defaultSql = def ? '1' : '0';
      }
    }
    inner = inner.wrapped;
  }

  // In Valibot v1, v.pipe(v.number(), v.integer()) produces an object where:
  //   .type === 'number'  AND  .pipe === [numberSchema, integerValidationAction]
  // Detect: base type is 'number' and .pipe contains an integer validation action.
  if (inner?.type === 'number' && Array.isArray(inner.pipe)) {
    const hasInteger = (inner.pipe as any[]).some(
      (item: any) => item.type === 'integer' && item.kind === 'validation',
    );
    if (hasInteger) {
      return { type: 'INTEGER', notNull: !nullable, default: defaultSql, isJson: false, isBoolean: false };
    }
  }

  const baseType: string = inner?.type ?? 'unknown';

  switch (baseType) {
    case 'string':
      return { type: 'TEXT', notNull: !nullable, default: defaultSql, isJson: false, isBoolean: false };
    case 'number':
      return { type: 'REAL', notNull: !nullable, default: defaultSql, isJson: false, isBoolean: false };
    case 'boolean':
      return { type: 'INTEGER', notNull: !nullable, default: defaultSql, isJson: false, isBoolean: true };
    case 'object':
    case 'array':
      return { type: 'TEXT', notNull: !nullable, default: defaultSql, isJson: true, isBoolean: false };
    default:
      return { type: 'TEXT', notNull: !nullable, default: defaultSql, isJson: false, isBoolean: false };
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
 *
 * Auto-columns (id, createdAt, updatedAt) are added by default; control via
 * the same `TableOptions` as the imperative `defineTable` in `d1-kyt/migrate`.
 *
 * @example
 * ```ts
 * import { defineTable } from 'd1-kyt/schema';
 * import * as v from 'valibot';
 *
 * export const users = defineTable('users', {
 *   email: v.string(),
 *   name: v.optional(v.string()),
 * });
 * ```
 */
export function defineTable<
  Cols extends Record<string, v.BaseSchema<any, any, any>>,
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
export function defineIndex<Cols extends Record<string, v.BaseSchema<any, any, any>>>(
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

  // Attach to table (array is mutable despite readonly property marker)
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

  // Attach to table
  (options.on._triggers as SchemaTrigger[]).push(trigger);

  return trigger;
}
