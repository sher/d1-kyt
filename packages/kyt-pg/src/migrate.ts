import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTransactionStatement } from './sql-scan.js';

export interface MigrateTx {
  unsafe(query: string, params?: any[]): PromiseLike<readonly any[]> & { simple(): PromiseLike<unknown> };
}

export interface MigrateClient {
  begin<T>(options: string, fn: (tx: MigrateTx) => Promise<T>): Promise<T>;
}

export interface MigrateOptions {
  dir: string;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const LOCK = 'select pg_advisory_xact_lock(7340225901)';
const READ_COMMITTED = 'isolation level read committed';

export async function migrate(sql: MigrateClient, options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? console.log;

  await sql.begin(READ_COMMITTED, async (tx) => {
    await tx.unsafe(LOCK);
    await tx.unsafe(
      'CREATE TABLE IF NOT EXISTS "KytMigration" ("name" text PRIMARY KEY, "checksum" text NOT NULL, "appliedAt" timestamptz NOT NULL DEFAULT now())',
    );
  });

  const files = readdirSync(options.dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const file of files) {
    const text = readFileSync(join(options.dir, file), 'utf8');
    const checksum = createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
    const status = await sql.begin(READ_COMMITTED, async (tx) => {
      await tx.unsafe(LOCK);
      const rows = await tx.unsafe('select "checksum" from "KytMigration" where "name" = $1', [file]);
      if (rows.length > 0) {
        if (rows[0].checksum !== checksum) {
          throw new Error(
            `kyt-pg: migration "${file}" changed after it ran. Restore the file, or add a new migration instead.`,
          );
        }
        return 'skipped' as const;
      }
      const word = findTransactionStatement(text);
      if (word) {
        throw new Error(
          `kyt-pg: migration "${file}" holds a ${word} statement. The runner wraps each file in a transaction, so remove BEGIN, COMMIT and ROLLBACK from the file.`,
        );
      }
      await tx.unsafe(text).simple();
      await tx.unsafe('insert into "KytMigration" ("name", "checksum") values ($1, $2)', [file, checksum]);
      return 'applied' as const;
    });
    result[status].push(file);
    log(`${status} ${file}`);
  }

  return result;
}
