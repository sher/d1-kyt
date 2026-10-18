import type { CompiledQuery } from 'kysely';

export interface SqlClient {
  unsafe(query: string, parameters?: any[]): PromiseLike<readonly any[] & { count: number }>;
}

export interface SqlRoot extends SqlClient {
  begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

async function run<T>(sql: SqlClient, q: CompiledQuery<T>) {
  return sql.unsafe(q.sql, q.parameters as any[]);
}

export async function queryAll<T>(sql: SqlClient, q: CompiledQuery<T>): Promise<T[]> {
  return [...(await run(sql, q))] as T[];
}

export async function queryFirst<T>(sql: SqlClient, q: CompiledQuery<T>): Promise<T | undefined> {
  return (await run(sql, q))[0] as T | undefined;
}

export async function queryRun(sql: SqlClient, q: CompiledQuery<unknown>): Promise<{ count: number }> {
  return { count: (await run(sql, q)).count };
}

export async function queryBatch(
  sql: SqlRoot,
  qs: readonly CompiledQuery<unknown>[],
): Promise<{ count: number }[]> {
  return sql.begin(async (tx) => {
    const results: { count: number }[] = [];
    for (const q of qs) results.push(await queryRun(tx, q));
    return results;
  });
}
