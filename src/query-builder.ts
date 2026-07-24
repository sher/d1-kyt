import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import type { VirtualTable } from './schema.js';
import { VirtualTablePlugin } from './virtual-table-plugin.js';

/**
 * Creates a Kysely query builder configured for D1 (SQLite).
 * Uses DummyDriver - queries are compiled only, never executed directly.
 * Execute compiled queries via createD1().
 *
 * Pass virtual tables to enable transparent query rewriting:
 * `db.selectFrom('PostForSale').selectAll()` rewrites to the source table.
 */
export function createQueryBuilder<DB>(virtualTables?: VirtualTable<any, any>[]): Kysely<DB> {
  const plugins = virtualTables && virtualTables.length > 0
    ? [new VirtualTablePlugin(virtualTables)]
    : [];
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
    plugins,
  });
}
