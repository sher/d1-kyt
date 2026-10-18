import {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { VirtualTable } from './virtual-table.js';
import { VirtualTablePlugin } from './virtual-table.js';

/**
 * Creates a Kysely query builder for Postgres.
 * It uses DummyDriver, so it only compiles queries. The app runs them with postgres.js.
 */
export function createQueryBuilder<DB>(virtualTables?: VirtualTable<any, any>[]): Kysely<DB> {
  const plugins = virtualTables && virtualTables.length > 0
    ? [new VirtualTablePlugin(virtualTables)]
    : [];
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins,
  });
}
