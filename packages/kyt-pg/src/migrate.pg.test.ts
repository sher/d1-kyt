import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { freshDb } from '../test/pg.js';
import { migrate, type MigrateClient } from './migrate.js';

describe('migrate', () => {
  let fresh: Awaited<ReturnType<typeof freshDb>>;
  let sql: typeof fresh.sql;
  let sql2: postgres.Sql;
  let dir: string;
  const log = () => {};

  beforeEach(async () => {
    fresh = await freshDb();
    sql = fresh.sql;
    sql2 = postgres(fresh.url, { types: { bigint: postgres.BigInt } });
    dir = mkdtempSync(join(tmpdir(), 'kyt-pg-migrate-'));
    writeFileSync(join(dir, '0001_a.sql'), 'create table "A" ("id" bigint primary key);\n');
    writeFileSync(
      join(dir, '0002_b.sql'),
      'create table "B" ("id" bigint primary key, "aId" bigint not null references "A" ("id"));\n',
    );
  });

  afterEach(async () => {
    await sql2.end();
    await fresh.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fits postgres.Sql', () => {
    expectTypeOf<postgres.Sql>().toExtend<MigrateClient>();
  });

  it('applies new files in name order and records them', async () => {
    expect(await migrate(sql, { dir, log })).toEqual({
      applied: ['0001_a.sql', '0002_b.sql'],
      skipped: [],
    });
    expect((await sql`select "name" from "KytMigration" order by "name"`).map((r) => r.name)).toEqual([
      '0001_a.sql',
      '0002_b.sql',
    ]);
  });

  it('skips files that already ran', async () => {
    await migrate(sql, { dir, log });
    expect(await migrate(sql, { dir, log })).toEqual({
      applied: [],
      skipped: ['0001_a.sql', '0002_b.sql'],
    });
  });

  it('stops when a file that ran has changed', async () => {
    await migrate(sql, { dir, log });
    appendFileSync(join(dir, '0001_a.sql'), '\n-- edit');
    await expect(migrate(sql, { dir, log })).rejects.toThrow(
      'kyt-pg: migration "0001_a.sql" changed after it ran.',
    );
  });

  it('treats CRLF and LF files as the same', async () => {
    await migrate(sql, { dir, log });
    writeFileSync(
      join(dir, '0001_a.sql'),
      readFileSync(join(dir, '0001_a.sql'), 'utf8').replace(/\n/g, '\r\n'),
    );
    await expect(migrate(sql, { dir, log })).resolves.toBeDefined();
  });

  it('leaves nothing behind when a file fails', async () => {
    writeFileSync(join(dir, '0003_bad.sql'), 'create table "C" ("id" bigint);\nselect from "NowhereTable";\n');
    await expect(migrate(sql, { dir, log })).rejects.toThrow();
    const [r] = await sql`select to_regclass('"C"') as c, (select count(*) from "KytMigration" where "name" = '0003_bad.sql')::int as n`;
    expect(r).toEqual({ c: null, n: 0 });
  });

  it('lets two runs at once apply each file one time', async () => {
    const [r1, r2] = await Promise.all([migrate(sql, { dir, log }), migrate(sql2, { dir, log })]);
    expect([...r1!.applied, ...r2!.applied].sort()).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('refuses a new file that holds a transaction statement', async () => {
    await migrate(sql, { dir, log });
    writeFileSync(join(dir, '0003_c.sql'), 'create table "C" ("id" bigint primary key);\nCOMMIT;\n');
    await expect(migrate(sql, { dir, log })).rejects.toThrow(
      'kyt-pg: migration "0003_c.sql" holds a COMMIT statement. The runner wraps each file in a transaction, so remove BEGIN, COMMIT and ROLLBACK from the file.',
    );
    const [row] = await sql`select to_regclass('"C"') as c, (select count(*)::int from "KytMigration" where "name" = '0003_c.sql') as n`;
    expect(row).toEqual({ c: null, n: 0 });
  });

  it('applies each file one time when the database defaults to serializable', async () => {
    const name = new URL(fresh.url).pathname.slice(1);
    await sql.unsafe(`alter database "${name}" set default_transaction_isolation = 'serializable'`);
    const clients = Array.from({ length: 4 }, () => postgres(fresh.url, { types: { bigint: postgres.BigInt } }));
    try {
      const [level] = await clients[0]!`show transaction_isolation`;
      expect(level!.transaction_isolation).toBe('serializable');
      let runs: Promise<Awaited<ReturnType<typeof migrate>>[]> | undefined;
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(7340225901)`;
        runs = Promise.all(clients.map((c) => migrate(c, { dir, log })));
        for (let waiting = 0; waiting < clients.length; ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const [row] = await sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`;
          waiting = row!.n;
        }
      });
      const results = await runs!;
      expect(results.flatMap((r) => r.applied).sort()).toEqual(['0001_a.sql', '0002_b.sql']);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });
});
