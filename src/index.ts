export { createQueryBuilder } from './query-builder.js';
export { VirtualTablePlugin } from './virtual-table-plugin.js';
export { queryAll, queryFirst, queryRun, queryBatch } from './executor.js';
export type { D1Database, D1RunResult } from './executor.js';

// schema
export {
  defineTable,
  defineVirtualTable,
  defineIndex,
  defineTrigger,
  withDefault,
  sqlTypeFromSchema,
  getTableRegistry,
} from './schema.js';
export type {
  InferDB,
  SchemaTable,
  VirtualTable,
  SchemaIndex,
  SchemaTrigger,
  SchemaForeignKey,
  WithDefault,
  AnyColSchema,
  ColumnTypeInfo,
  SqliteType,
  TableOptions,
} from './schema.js';

// config
export { defineConfig } from './config.js';
export type { JikuConfig, NamingStrategy } from './config.js';

// validators
export { d1MaxParams, d1MaxSqlLength, D1_VALIDATORS, runValidators } from './validators.js';
export { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_LENGTH, D1_MAX_COLUMNS } from './validators.js';
export type { QueryValidator } from './validators.js';
