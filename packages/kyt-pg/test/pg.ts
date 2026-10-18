import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { inject } from 'vitest';

export async function freshDb(): Promise<{
  sql: postgres.Sql;
  url: string;
  close(): Promise<void>;
}> {
  const admin = postgres(inject('pgUrl'));
  const name = `t_${randomBytes(8).toString('hex')}`;
  await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const url = new URL(inject('pgUrl'));
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { types: { bigint: postgres.BigInt } });
  return { sql, url: url.toString(), close: () => sql.end() };
}
