import type { PgType } from '../src/schema.js';
import type { SchemaSnapshot } from '../src/snapshot.js';

const dataTypes: Record<PgType, string> = {
  text: 'text',
  uuid: 'uuid',
  integer: 'integer',
  bigint: 'bigint',
  boolean: 'boolean',
  jsonb: 'jsonb',
  timestamptz: 'timestamp with time zone',
  'double precision': 'double precision',
};

export function expectedFrom(snapshot: SchemaSnapshot) {
  const rows: { table_name: string; column_name: string; data_type: string; is_nullable: string }[] = [];
  for (const table of Object.values(snapshot.tables)) {
    for (const col of Object.values(table.columns)) {
      rows.push({
        table_name: table.name,
        column_name: col.name,
        data_type: dataTypes[col.type],
        is_nullable: col.notNull ? 'NO' : 'YES',
      });
    }
  }
  return rows;
}

export function sorted<T extends { table_name: string }>(rows: T[]): T[] {
  const names = [...new Set(rows.map((r) => r.table_name))].sort();
  return names.flatMap((n) => rows.filter((r) => r.table_name === n));
}
