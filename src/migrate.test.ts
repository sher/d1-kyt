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

    expect(Place.sql[1]).toContain('CREATE TRIGGER "Place_updatedAt"');
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
    expect(sql).toBe('CREATE UNIQUE INDEX "Place_name_unique" ON "Place"("name");');
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
    expect(result[1]).toBe('DROP TRIGGER IF EXISTS "Place_updatedAt";');
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
