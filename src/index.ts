export { createQueryBuilder } from './query-builder.js';
export { queryAll, queryFirst, queryRun, queryBatch } from './executor.js';
export type { D1Database, D1RunResult } from './executor.js';

// schema
export {
  defineTable,
  defineIndex,
  defineTrigger,
  sqlTypeFromSchema,
} from './schema.js';
export type {
  InferDB,
  SchemaTable,
  SchemaIndex,
  SchemaTrigger,
  SchemaForeignKey,
  ColumnTypeInfo,
  SqliteType,
  TableOptions,
} from './schema.js';

// config
export { defineConfig } from './config.js';
export type { D1KytConfig, NamingStrategy } from './config.js';
