import { expect, it } from 'vitest';
import { freshDb } from '../test/pg.js';

it('reaches a fresh database', async () => {
  const db = await freshDb();
  const [row] = await db.sql`select 1::bigint as n`;
  expect(row.n).toBe(1n);
  await db.close();
});
