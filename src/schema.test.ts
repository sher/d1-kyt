import { describe, it, expect, expectTypeOf } from 'vitest';
import * as v from 'valibot';
import type { ColumnType, Generated } from 'kysely';
import {
  defineTable,
  defineVirtualTable,
  defineIndex,
  defineTrigger,
  sqlTypeFromSchema,
  withDefault,
  getTableRegistry,
  type InferDB,
} from './schema.js';

// ----------------------------------------------------------------------------
// sqlTypeFromSchema
// ----------------------------------------------------------------------------

describe('sqlTypeFromSchema', () => {
  it('maps v.string() to TEXT NOT NULL', () => {
    expect(sqlTypeFromSchema(v.string())).toMatchObject({
      type: 'TEXT', notNull: true, isJson: false, isBoolean: false,
    });
  });

  it('maps v.number() to REAL NOT NULL', () => {
    expect(sqlTypeFromSchema(v.number())).toMatchObject({
      type: 'REAL', notNull: true, isJson: false, isBoolean: false,
    });
  });

  it('maps v.pipe(v.number(), v.integer()) to INTEGER NOT NULL', () => {
    expect(sqlTypeFromSchema(v.pipe(v.number(), v.integer()))).toMatchObject({
      type: 'INTEGER', notNull: true, isJson: false, isBoolean: false,
    });
  });

  it('maps v.boolean() to INTEGER NOT NULL', () => {
    expect(sqlTypeFromSchema(v.boolean())).toMatchObject({
      type: 'INTEGER', notNull: true, isJson: false, isBoolean: true,
    });
  });

  it('maps v.object() to TEXT NOT NULL (JSON)', () => {
    expect(sqlTypeFromSchema(v.object({ a: v.string() }))).toMatchObject({
      type: 'TEXT', notNull: true, isJson: true, isBoolean: false,
    });
  });

  it('maps v.array() to TEXT NOT NULL (JSON)', () => {
    expect(sqlTypeFromSchema(v.array(v.string()))).toMatchObject({
      type: 'TEXT', notNull: true, isJson: true, isBoolean: false,
    });
  });

  it('maps v.nullable(v.string()) to TEXT NULL', () => {
    expect(sqlTypeFromSchema(v.nullable(v.string()))).toMatchObject({
      type: 'TEXT', notNull: false, isJson: false, isBoolean: false,
    });
  });

  it('maps v.nullable(v.pipe(v.number(), v.integer())) to INTEGER NULL', () => {
    expect(sqlTypeFromSchema(v.nullable(v.pipe(v.number(), v.integer())))).toMatchObject({
      type: 'INTEGER', notNull: false, isJson: false, isBoolean: false,
    });
  });

  it('maps v.nullable(v.object()) to TEXT NULL (JSON)', () => {
    expect(sqlTypeFromSchema(v.nullable(v.object({ a: v.string() })))).toMatchObject({
      type: 'TEXT', notNull: false, isJson: true, isBoolean: false,
    });
  });

  it('maps withDefault(v.boolean(), false) to INTEGER NOT NULL DEFAULT 0', () => {
    expect(sqlTypeFromSchema(withDefault(v.boolean(), false))).toMatchObject({
      type: 'INTEGER', notNull: true, default: '0', isJson: false, isBoolean: true,
    });
  });

  it('maps withDefault(v.boolean(), true) to INTEGER NOT NULL DEFAULT 1', () => {
    expect(sqlTypeFromSchema(withDefault(v.boolean(), true))).toMatchObject({
      type: 'INTEGER', notNull: true, default: '1', isJson: false, isBoolean: true,
    });
  });

  it('maps withDefault(v.string(), "guest") to TEXT NOT NULL DEFAULT', () => {
    expect(sqlTypeFromSchema(withDefault(v.string(), 'guest'))).toMatchObject({
      type: 'TEXT', notNull: true, default: "'guest'", isJson: false, isBoolean: false,
    });
  });

  it('maps withDefault(v.number(), 0) to REAL NOT NULL DEFAULT 0', () => {
    expect(sqlTypeFromSchema(withDefault(v.number(), 0))).toMatchObject({
      type: 'REAL', notNull: true, default: '0', isJson: false, isBoolean: false,
    });
  });

  it('maps withDefault(v.pipe(v.number(), v.integer()), 1) to INTEGER NOT NULL DEFAULT 1', () => {
    expect(sqlTypeFromSchema(withDefault(v.pipe(v.number(), v.integer()), 1))).toMatchObject({
      type: 'INTEGER', notNull: true, default: '1', isJson: false, isBoolean: false,
    });
  });
});

// ----------------------------------------------------------------------------
// defineTable
// ----------------------------------------------------------------------------

describe('defineTable', () => {
  it('returns SchemaTable with correct metadata', () => {
    const users = defineTable('users', {
      email: v.string(),
      name: v.nullable(v.string()),
    });

    expect(users._name).toBe('users');
    expect(Object.keys(users._columns)).toEqual(['email', 'name']);
    expect(users._indexes).toEqual([]);
    expect(users._triggers).toEqual([]);
    expect(users._schemaTable).toBe(true);
  });

  it('accepts custom TableOptions', () => {
    const t = defineTable(
      'custom',
      { slug: v.string() },
      { primaryKey: false, createdAt: false, updatedAt: false },
    );
    expect(t._options).toMatchObject({ primaryKey: false, createdAt: false, updatedAt: false });
  });

  it('$inferSelect: required column is base type', () => {
    const users = defineTable('users_inf', { email: v.string() });
    type S = typeof users.$inferSelect;
    expectTypeOf<S['email']>().toEqualTypeOf<string>();
  });

  it('$inferSelect: nullable column is T | null', () => {
    const users = defineTable('users_inf2', {
      email: v.string(),
      name: v.nullable(v.string()),
    });
    type S = typeof users.$inferSelect;
    expectTypeOf<S['name']>().toEqualTypeOf<string | null>();
  });

  it('$inferSelect: withDefault column is base type (not undefined)', () => {
    const t = defineTable('users_wd', { active: withDefault(v.boolean(), false) });
    type S = typeof t.$inferSelect;
    expectTypeOf<S['active']>().toEqualTypeOf<boolean>();
  });

  it('$inferSelect: includes auto id as number', () => {
    const t = defineTable('t_auto', { x: v.string() });
    type S = typeof t.$inferSelect;
    expectTypeOf<S['id']>().toEqualTypeOf<number>();
    expectTypeOf<S['createdAt']>().toEqualTypeOf<string>();
    expectTypeOf<S['updatedAt']>().toEqualTypeOf<string>();
  });

  it('$inferInsert: required column stays required', () => {
    const t = defineTable('t_ins', { email: v.string() });
    type I = typeof t.$inferInsert;
    expectTypeOf<I['email']>().toEqualTypeOf<string>();
  });

  it('$inferInsert: nullable column is optional on insert', () => {
    const t = defineTable('t_ins2', { name: v.nullable(v.string()) });
    type I = typeof t.$inferInsert;
    expectTypeOf<I['name']>().toEqualTypeOf<string | null | undefined>();
  });

  it('$inferInsert: withDefault column is optional on insert', () => {
    const t = defineTable('t_ins_wd', { active: withDefault(v.boolean(), false) });
    type I = typeof t.$inferInsert;
    expectTypeOf<I['active']>().toEqualTypeOf<boolean | undefined>();
  });

  it('$inferInsert: id is optional', () => {
    const t = defineTable('t_ins3', { x: v.string() });
    type I = typeof t.$inferInsert;
    expectTypeOf<I['id']>().toEqualTypeOf<number | undefined>();
  });
});

// ----------------------------------------------------------------------------
// defineIndex
// ----------------------------------------------------------------------------

describe('defineIndex', () => {
  it('creates an index with auto-generated name', () => {
    const users = defineTable('idx_users', { email: v.string() });
    const idx = defineIndex(users, ['email'], { unique: true });

    expect(idx.name).toBe('idx_users_email_uq');
    expect(idx.columns).toEqual(['email']);
    expect(idx.unique).toBe(true);
    expect(idx._tableName).toBe('idx_users');
  });

  it('attaches the index to the table', () => {
    const users = defineTable('idx_attach', { email: v.string() });
    const idx = defineIndex(users, ['email']);
    expect(users._indexes).toHaveLength(1);
    expect(users._indexes[0]).toBe(idx);
  });

  it('auto-names non-unique index with _idx suffix', () => {
    const t = defineTable('idx_name', { cityId: v.pipe(v.number(), v.integer()) });
    const idx = defineIndex(t, ['cityId']);
    expect(idx.name).toBe('idx_name_cityId_idx');
  });

  it('accepts a custom index name', () => {
    const t = defineTable('idx_custom', { email: v.string() });
    const idx = defineIndex(t, ['email'], { name: 'my_custom_idx' });
    expect(idx.name).toBe('my_custom_idx');
  });

  it('accepts a where clause for partial index', () => {
    const t = defineTable('idx_partial', { email: v.string(), active: v.boolean() });
    const idx = defineIndex(t, ['email'], { where: '"active" = 1' });
    expect(idx.where).toBe('"active" = 1');
  });

  it('accepts composite columns', () => {
    const t = defineTable('idx_comp', { a: v.string(), b: v.string() });
    const idx = defineIndex(t, ['a', 'b']);
    expect(idx.name).toBe('idx_comp_a_b_idx');
    expect(idx.columns).toEqual(['a', 'b']);
  });

  it('type error: column name not in table columns', () => {
    const users = defineTable('idx_type', { email: v.string() });
    // @ts-expect-error 'nonexistent' is not a key of the table's columns
    defineIndex(users, ['nonexistent']);
  });
});

// ----------------------------------------------------------------------------
// defineTrigger
// ----------------------------------------------------------------------------

describe('defineTrigger', () => {
  it('creates a trigger and attaches it to the table', () => {
    const users = defineTable('trg_users', { email: v.string() });
    const trg = defineTrigger('trg_users_audit', {
      timing: 'AFTER',
      event: 'INSERT',
      on: users,
      body: `INSERT INTO audit (action) VALUES ('insert');`,
    });

    expect(trg.name).toBe('trg_users_audit');
    expect(trg.timing).toBe('AFTER');
    expect(trg.event).toBe('INSERT');
    expect(trg.tableName).toBe('trg_users');
    expect(users._triggers).toHaveLength(1);
    expect(users._triggers[0]).toBe(trg);
  });

  it('supports BEFORE event', () => {
    const t = defineTable('trg_before', { x: v.string() });
    const trg = defineTrigger('trg_before_del', {
      timing: 'BEFORE',
      event: 'DELETE',
      on: t,
      body: 'SELECT 1;',
    });
    expect(trg.timing).toBe('BEFORE');
    expect(trg.event).toBe('DELETE');
  });

  it('multiple triggers on same table', () => {
    const t = defineTable('trg_multi', { x: v.string() });
    defineTrigger('trg_multi_ins', { timing: 'AFTER', event: 'INSERT', on: t, body: 'SELECT 1;' });
    defineTrigger('trg_multi_upd', { timing: 'AFTER', event: 'UPDATE', on: t, body: 'SELECT 2;' });
    expect(t._triggers).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// InferDB
// ----------------------------------------------------------------------------

describe('InferDB', () => {
  const Match = defineTable('Match', {
    league: v.string(),
    score: v.pipe(v.number(), v.integer()),
    rating: v.number(),
    active: v.boolean(),
    nickname: withDefault(v.string(), 'anon'),
    defaultBool: withDefault(v.boolean(), false),
    note: v.nullable(v.string()),
    meta: v.object({ key: v.string() }),
    tags: v.array(v.string()),
    nullableMeta: v.nullable(v.object({ key: v.string() })),
    nullableName: v.nullable(v.string()),
    nullableObj: v.nullable(v.object({ x: v.number() })),
  });

  type DB = InferDB<{ Match: typeof Match }>;
  type Row = DB['Match'];

  it('required string column → string', () => {
    expectTypeOf<Row['league']>().toEqualTypeOf<string>();
  });

  it('required integer column → number', () => {
    expectTypeOf<Row['score']>().toEqualTypeOf<number>();
  });

  it('required number column → number', () => {
    expectTypeOf<Row['rating']>().toEqualTypeOf<number>();
  });

  it('required boolean column → boolean', () => {
    expectTypeOf<Row['active']>().toEqualTypeOf<boolean>();
  });

  it('withDefault string → Generated<string>', () => {
    expectTypeOf<Row['nickname']>().toEqualTypeOf<Generated<string>>();
  });

  it('withDefault boolean → Generated<boolean>', () => {
    expectTypeOf<Row['defaultBool']>().toEqualTypeOf<Generated<boolean>>();
  });

  it('nullable string → string | null', () => {
    expectTypeOf<Row['note']>().toEqualTypeOf<string | null>();
  });

  it('required JSON object → ColumnType<T, T, T>', () => {
    expectTypeOf<Row['meta']>().toEqualTypeOf<ColumnType<{ key: string }, { key: string }, { key: string }>>();
  });

  it('required JSON array → ColumnType<T, T, T>', () => {
    expectTypeOf<Row['tags']>().toEqualTypeOf<ColumnType<string[], string[], string[]>>();
  });

  it('nullable JSON object → T | null', () => {
    expectTypeOf<Row['nullableMeta']>().toEqualTypeOf<{ key: string } | null>();
  });

  it('nullable string → T | null', () => {
    expectTypeOf<Row['nullableName']>().toEqualTypeOf<string | null>();
  });

  it('nullable JSON object (nullableObj) → T | null', () => {
    expectTypeOf<Row['nullableObj']>().toEqualTypeOf<{ x: number } | null>();
  });

  it('auto id → Generated<number>', () => {
    expectTypeOf<Row['id']>().toEqualTypeOf<Generated<number>>();
  });

  it('auto createdAt → Generated<string>', () => {
    expectTypeOf<Row['createdAt']>().toEqualTypeOf<Generated<string>>();
  });

  it('auto updatedAt → Generated<string>', () => {
    expectTypeOf<Row['updatedAt']>().toEqualTypeOf<Generated<string>>();
  });

  it('primaryKey: false suppresses id column', () => {
    const NoId = defineTable('NoId', { name: v.string() }, { primaryKey: false });
    type NoIdDB = InferDB<{ NoId: typeof NoId }>;
    // @ts-expect-error id should not exist when primaryKey: false
    type _check = NoIdDB['NoId']['id'];
  });

  it('custom primaryKeyColumn name is respected', () => {
    const Custom = defineTable(
      'Custom',
      { name: v.string() },
      { primaryKeyColumn: 'uid' as const },
    );
    type CustomDB = InferDB<{ Custom: typeof Custom }>;
    expectTypeOf<CustomDB['Custom']['uid']>().toEqualTypeOf<Generated<number>>();
  });
});

// ----------------------------------------------------------------------------
// defineVirtualTable
// ----------------------------------------------------------------------------

describe('defineVirtualTable', () => {
  const Product = defineTable('vt_product', {
    name: v.string(),
    priceYen: v.nullable(v.pipe(v.number(), v.integer())),
    condition: v.nullable(v.string()),
    category: v.string(),
  });

  it('picks only the specified columns', () => {
    const vt = defineVirtualTable('VtProduct1', Product, ['name', 'priceYen']);
    expect(Object.keys(vt._columns)).toEqual(['name', 'priceYen']);
  });

  it('uses the given name, references source table via _source', () => {
    const vt = defineVirtualTable('VtProduct2', Product, ['name']);
    expect(vt._name).toBe('VtProduct2');
    expect(vt._source).toBe(Product);
    expect(vt._source._name).toBe('vt_product');
  });

  it('is NOT registered in tableRegistry', () => {
    const Source = defineTable('vt_source_real', { x: v.string(), y: v.string() });
    defineVirtualTable('VtSource', Source, ['x']);
    expect(getTableRegistry().has('vt_source_real')).toBe(true);
    expect(getTableRegistry().has('VtSource')).toBe(false);
  });

  it('$inferSelect: picked columns have correct types', () => {
    const vt = defineVirtualTable('VtProduct3', Product, ['name', 'priceYen']);
    type S = typeof vt.$inferSelect;
    expectTypeOf<S['name']>().toEqualTypeOf<string>();
    expectTypeOf<S['priceYen']>().toEqualTypeOf<number | null>();
  });

  it('$inferSelect: unpicked columns are not present', () => {
    const vt = defineVirtualTable('VtProduct4', Product, ['name']);
    type S = typeof vt.$inferSelect;
    // @ts-expect-error 'condition' was not picked
    type _check = S['condition'];
  });

  it('type error: column not in source table', () => {
    // @ts-expect-error 'nonexistent' is not a key of Product columns
    defineVirtualTable('VtProduct5', Product, ['nonexistent']);
  });

  it('defineIndex on virtual table targets source table', () => {
    const vt = defineVirtualTable('VtProductIdx', Product, ['priceYen', 'condition']);
    const initialCount = Product._indexes.length;
    const idx = defineIndex(vt, ['priceYen']);
    expect(idx._tableName).toBe('vt_product');
    expect(idx.name).toBe('vt_product_priceYen_idx');
    expect(Product._indexes.length).toBe(initialCount + 1);
    expect(Product._indexes).toContain(idx);
  });

  it('defineIndex on virtual table: type error for unpicked column', () => {
    const vt = defineVirtualTable('VtProductIdx2', Product, ['priceYen']);
    // @ts-expect-error 'condition' was not picked into this virtual table
    defineIndex(vt, ['condition']);
  });

  it('joins: merges columns from joined table into _columns', () => {
    const Seller = defineTable('vt_seller', { shopName: v.string() });
    const vt = defineVirtualTable('VtProductWithSeller', Product, ['name'], {
      joins: [{ table: Seller, on: ['category', 'shopName'], columns: ['shopName'], type: 'inner' }],
    });
    expect(Object.keys(vt._columns).sort()).toEqual(['name', 'shopName']);
    expect(vt._joins).toHaveLength(1);
    expect(vt._joins[0].table).toBe(Seller);
  });

  it('joins: $inferSelect includes joined column types', () => {
    const Seller2 = defineTable('vt_seller2', { shopName: v.string() });
    const vt = defineVirtualTable('VtProductWithSeller2', Product, ['name'], {
      joins: [{ table: Seller2, on: ['category', 'shopName'], columns: ['shopName'], type: 'inner' }],
    });
    type S = typeof vt.$inferSelect;
    expectTypeOf<S['shopName']>().toEqualTypeOf<string>();
  });
});

// ----------------------------------------------------------------------------
// table registry
// ----------------------------------------------------------------------------

describe('getTableRegistry', () => {
  it('contains a table after defineTable is called', () => {
    const reg_table = defineTable('reg_table_test', { name: v.string() });
    expect(getTableRegistry().get('reg_table_test')).toBe(reg_table);
  });

  it('returns the same instance registered by defineTable', () => {
    const t = defineTable('reg_identity_test', { val: v.number() });
    expect(getTableRegistry().get('reg_identity_test')).toBe(t);
  });
});
