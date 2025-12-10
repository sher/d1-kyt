import { describe, it, expect } from 'vitest';
import {
  defineTable,
  useTable,
  createUseTable,
  createIndex,
  dropIndex,
  addColumn,
  dropTable,
} from './migrate.js';

describe('defineTable', () => {
  it('returns Table with sql property', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
      cityId: col.integer().notNull(),
    }));

    expect(Place._name).toBe('Place');
    expect(Place.sql).toHaveLength(2);
  });

  it('generates CREATE TABLE with auto columns', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
      cityId: col.integer().notNull(),
    }));

    expect(Place.sql[0]).toBe(`CREATE TABLE "Place" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL,
  "cityId" INTEGER NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  });

  it('generates CREATE TRIGGER', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }));

    expect(Place.sql[1]).toContain('CREATE TRIGGER "Place_updatedAt_trg"');
    expect(Place.sql[1]).toContain('AFTER UPDATE ON "Place"');
  });

  it('handles default values', () => {
    const Post = defineTable('Post', (col) => ({
      title: col.text().notNull(),
      status: col.text().notNull().default("'draft'"),
      views: col.integer().default('0'),
    }));

    expect(Post.sql[0]).toContain(`"status" TEXT NOT NULL DEFAULT 'draft'`);
    expect(Post.sql[0]).toContain(`"views" INTEGER DEFAULT 0`);
  });

  it('handles all column types', () => {
    const Mixed = defineTable('Mixed', (col) => ({
      textCol: col.text(),
      intCol: col.integer(),
      realCol: col.real(),
      blobCol: col.blob(),
    }));

    expect(Mixed.sql[0]).toContain('"textCol" TEXT');
    expect(Mixed.sql[0]).toContain('"intCol" INTEGER');
    expect(Mixed.sql[0]).toContain('"realCol" REAL');
    expect(Mixed.sql[0]).toContain('"blobCol" BLOB');
  });

  it('disables primary key column', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }), { primaryKey: false });

    expect(Place.sql[0]).not.toContain('"id"');
    expect(Place.sql[0]).toContain('"name"');
    expect(Place.sql[0]).toContain('"createdAt"');
    expect(Place.sql[0]).toContain('"updatedAt"');
  });

  it('disables createdAt column', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }), { createdAt: false });

    expect(Place.sql[0]).toContain('"id"');
    expect(Place.sql[0]).not.toContain('"createdAt"');
    expect(Place.sql[0]).toContain('"updatedAt"');
  });

  it('disables updatedAt column and trigger', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }), { updatedAt: false });

    expect(Place.sql[0]).toContain('"id"');
    expect(Place.sql[0]).toContain('"createdAt"');
    expect(Place.sql[0]).not.toContain('"updatedAt"');
    expect(Place.sql).toHaveLength(1); // no trigger
  });

  it('disables all auto columns', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }), { primaryKey: false, createdAt: false, updatedAt: false });

    expect(Place.sql[0]).toBe(`CREATE TABLE "Place" (
  "name" TEXT NOT NULL
);`);
    expect(Place.sql).toHaveLength(1);
  });

  it('uses custom column names', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }), {
      primaryKeyColumn: 'place_id',
      createdAtColumn: 'created_at',
      updatedAtColumn: 'updated_at',
    });

    expect(Place.sql[0]).toContain('"place_id" INTEGER PRIMARY KEY');
    expect(Place.sql[0]).toContain('"created_at" TEXT NOT NULL DEFAULT');
    expect(Place.sql[0]).toContain('"updated_at" TEXT NOT NULL DEFAULT');
    expect(Place.sql[1]).toContain('CREATE TRIGGER "Place_updated_at_trg"');
    expect(Place.sql[1]).toContain('SET "updated_at" = datetime');
    expect(Place.sql[1]).toContain('WHERE "place_id" = NEW."place_id"');
  });

  it('uses first user column as pk when primaryKey disabled with updatedAt enabled', () => {
    const Place = defineTable('Place', (col) => ({
      uuid: col.text().notNull(),
      name: col.text().notNull(),
    }), { primaryKey: false });

    expect(Place.sql[1]).toContain('WHERE "uuid" = NEW."uuid"');
  });
});

describe('useTable', () => {
  it('creates table reference', () => {
    interface PlaceTable {
      id: number;
      name: string;
      cityId: number;
    }

    const Place = useTable<PlaceTable>('Place');
    expect(Place._name).toBe('Place');
  });
});

describe('createUseTable', () => {
  it('creates typed useTable function', () => {
    interface DB {
      Place: { id: number; name: string; cityId: number };
      City: { id: number; name: string };
    }

    const useTable = createUseTable<DB>();

    const Place = useTable('Place');
    const City = useTable('City');

    expect(Place._name).toBe('Place');
    expect(City._name).toBe('City');
  });

  it('works with createIndex', () => {
    interface DB {
      Place: { id: number; name: string; cityId: number };
    }

    const useTable = createUseTable<DB>();
    const Place = useTable('Place');

    const sql = createIndex(Place, ['cityId']);
    expect(sql).toBe('CREATE INDEX "Place_cityId_idx" ON "Place"("cityId");');
  });
});

describe('createIndex', () => {
  it('creates simple index', () => {
    const Place = defineTable('Place', (col) => ({
      cityId: col.integer().notNull(),
    }));

    const sql = createIndex(Place, ['cityId']);
    expect(sql).toBe('CREATE INDEX "Place_cityId_idx" ON "Place"("cityId");');
  });

  it('creates unique index', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }));

    const sql = createIndex(Place, ['name'], { unique: true });
    expect(sql).toBe('CREATE UNIQUE INDEX "Place_name_uq" ON "Place"("name");');
  });

  it('creates composite index', () => {
    const Place = defineTable('Place', (col) => ({
      status: col.text().notNull(),
      cityId: col.integer().notNull(),
    }));

    const sql = createIndex(Place, ['status', 'cityId']);
    expect(sql).toBe('CREATE INDEX "Place_status_cityId_idx" ON "Place"("status", "cityId");');
  });

  it('allows custom index name', () => {
    const Place = defineTable('Place', (col) => ({
      cityId: col.integer().notNull(),
    }));

    const sql = createIndex(Place, ['cityId'], { name: 'idx_place_city' });
    expect(sql).toBe('CREATE INDEX "idx_place_city" ON "Place"("cityId");');
  });

  it('allows custom name with unique', () => {
    const Place = defineTable('Place', (col) => ({
      email: col.text().notNull(),
    }));

    const sql = createIndex(Place, ['email'], { unique: true, name: 'uq_place_email' });
    expect(sql).toBe('CREATE UNIQUE INDEX "uq_place_email" ON "Place"("email");');
  });

  it('works with useTable', () => {
    interface PlaceTable {
      id: number;
      name: string;
      cityId: number;
    }

    const Place = useTable<PlaceTable>('Place');
    const sql = createIndex(Place, ['cityId']);
    expect(sql).toBe('CREATE INDEX "Place_cityId_idx" ON "Place"("cityId");');
  });
});

describe('dropIndex', () => {
  it('drops index by name', () => {
    const sql = dropIndex('Place_cityId_idx');
    expect(sql).toBe('DROP INDEX "Place_cityId_idx";');
  });
});

describe('addColumn', () => {
  it('adds simple column', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }));

    const sql = addColumn(Place, 'rating', (col) => col.real());
    expect(sql).toBe('ALTER TABLE "Place" ADD COLUMN "rating" REAL;');
  });

  it('adds column with not null and default', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }));

    const sql = addColumn(Place, 'featured', (col) =>
      col.integer().notNull().default('0')
    );
    expect(sql).toBe('ALTER TABLE "Place" ADD COLUMN "featured" INTEGER NOT NULL DEFAULT 0;');
  });

  it('works with useTable', () => {
    interface PlaceTable {
      id: number;
      name: string;
    }

    const Place = useTable<PlaceTable>('Place');
    const sql = addColumn(Place, 'rating', (col) => col.real());
    expect(sql).toBe('ALTER TABLE "Place" ADD COLUMN "rating" REAL;');
  });
});

describe('dropTable', () => {
  it('drops table and trigger', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }));

    const result = dropTable(Place);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe('DROP TABLE "Place";');
    expect(result[1]).toBe('DROP TRIGGER IF EXISTS "Place_updatedAt_trg";');
  });

  it('drops table with custom updatedAt column name', () => {
    const Place = defineTable('Place', (col) => ({
      name: col.text().notNull(),
    }), { updatedAtColumn: 'updated_at' });

    const result = dropTable(Place, 'updated_at');

    expect(result[0]).toBe('DROP TABLE "Place";');
    expect(result[1]).toBe('DROP TRIGGER IF EXISTS "Place_updated_at_trg";');
  });

  it('works with useTable', () => {
    interface PlaceTable {
      id: number;
      name: string;
    }

    const Place = useTable<PlaceTable>('Place');
    const result = dropTable(Place);

    expect(result[0]).toBe('DROP TABLE "Place";');
  });
});
