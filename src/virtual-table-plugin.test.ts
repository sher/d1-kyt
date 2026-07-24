import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { createQueryBuilder, defineTable, defineVirtualTable, withDefault, type InferDB } from './index.js';

const Post = defineTable('Post', {
  category: v.string(),
  itemType: v.nullable(v.string()),
  priceYen: v.nullable(v.pipe(v.number(), v.integer())),
  condition: v.nullable(v.string()),
  rent: v.nullable(v.pipe(v.number(), v.integer())),
  location: v.nullable(v.string()),
  approved: withDefault(v.boolean(), false),
});

const PostForSale = defineVirtualTable(
  'PostForSale',
  Post,
  ['itemType', 'priceYen', 'condition', 'location'],
  { where: { category: 'for_sale' } },
);

const PostHousing = defineVirtualTable(
  'PostHousing',
  Post,
  ['rent', 'location'],
  { where: { category: 'housing' } },
);

type DB = InferDB<{
  Post: typeof Post;
  PostForSale: typeof PostForSale;
  PostHousing: typeof PostHousing;
}>;

const db = createQueryBuilder<DB>([PostForSale, PostHousing]);

function sql(q: { compile(): { sql: string; parameters: readonly unknown[] } }) {
  const c = q.compile();
  return { sql: c.sql, params: c.parameters };
}

describe('VirtualTablePlugin', () => {
  it('rewrites FROM virtual table to source table', () => {
    const q = db.selectFrom('PostForSale').selectAll();
    const { sql: s } = sql(q);
    expect(s).toContain('"Post"');
    expect(s).not.toContain('"PostForSale"');
  });

  it('injects WHERE from _where filter', () => {
    const q = db.selectFrom('PostForSale').selectAll();
    const { sql: s, params } = sql(q);
    expect(s).toContain('where');
    expect(params).toContain('for_sale');
  });

  it('expands selectAll to virtual table columns + auto-columns', () => {
    const q = db.selectFrom('PostForSale').selectAll();
    const { sql: s } = sql(q);
    expect(s).toContain('"id"');
    expect(s).toContain('"itemType"');
    expect(s).toContain('"priceYen"');
    expect(s).toContain('"condition"');
    expect(s).toContain('"location"');
    expect(s).not.toContain('"rent"');
  });

  it('ANDs user WHERE with virtual table filter', () => {
    const q = db.selectFrom('PostForSale').selectAll().where('priceYen', '<', 5000);
    const { sql: s, params } = sql(q);
    expect(params).toContain('for_sale');
    expect(params).toContain(5000);
    expect(s.match(/where/gi)?.length).toBe(1);
  });

  it('does not affect queries on real tables', () => {
    const q = db.selectFrom('Post').selectAll();
    const { sql: s } = sql(q);
    expect(s).toBe('select * from "Post"');
  });

  it('handles multiple virtual tables independently', () => {
    const forSale = sql(db.selectFrom('PostForSale').selectAll());
    const housing = sql(db.selectFrom('PostHousing').selectAll());

    expect(forSale.params).toContain('for_sale');
    expect(housing.params).toContain('housing');
    expect(forSale.sql).toContain('"itemType"');
    expect(housing.sql).toContain('"rent"');
    expect(forSale.sql).not.toContain('"rent"');
  });

  it('rewrites an aliased virtual table reference, preserving the alias', () => {
    const q = db.selectFrom('PostForSale as p').select('p.itemType');
    const { sql: s } = sql(q);
    expect(s).toContain('"Post" as "p"');
    expect(s).toContain('"p"."itemType"');
    expect(s).not.toContain('"PostForSale"');
  });

  it('applies the where filter to an aliased virtual table reference', () => {
    const q = db.selectFrom('PostForSale as p').selectAll();
    const { params } = sql(q);
    expect(params).toContain('for_sale');
  });

  it('throws when inserting into a virtual table', () => {
    expect(() =>
      (db.insertInto as any)('PostForSale').values({ itemType: 'x' }).compile(),
    ).toThrow(/virtual table/i);
  });

  it('throws when updating a virtual table', () => {
    expect(() =>
      (db.updateTable as any)('PostForSale').set({ itemType: 'x' }).compile(),
    ).toThrow(/virtual table/i);
  });

  it('throws when deleting from a virtual table', () => {
    expect(() => (db.deleteFrom as any)('PostForSale').compile()).toThrow(/virtual table/i);
  });
});

describe('VirtualTablePlugin joins', () => {
  const Article = defineTable('vtp_article', {
    title: v.string(),
    authorId: v.pipe(v.number(), v.integer()),
  });
  const Author = defineTable('vtp_author', {
    name: v.string(),
  });

  const ArticleWithAuthor = defineVirtualTable('ArticleWithAuthor', Article, ['title'], {
    joins: [{ table: Author, on: ['authorId', 'id'], columns: ['name'], type: 'inner' }],
  });

  type DB2 = InferDB<{
    vtp_article: typeof Article;
    vtp_author: typeof Author;
    ArticleWithAuthor: typeof ArticleWithAuthor;
  }>;

  const db2 = createQueryBuilder<DB2>([ArticleWithAuthor]);

  it('builds an inner join and qualifies selected columns per source table', () => {
    const q = db2.selectFrom('ArticleWithAuthor').selectAll();
    const { sql: s } = sql(q);
    expect(s).toContain('inner join "vtp_author"');
    expect(s).toContain('"vtp_article"."authorId" = "vtp_author"."id"');
    expect(s).toContain('"vtp_article"."title"');
    expect(s).toContain('"vtp_author"."name"');
  });
});
