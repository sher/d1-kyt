#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const VERSION = '0.10.4';

const HELP = `
d1-kyt v${VERSION} - Opinionated Cloudflare D1 + Kysely toolkit

Usage:
  d1-kyt init [--dir <dir>]
  d1-kyt schema:diff [name] [--dir <dir>] [--schema <path>]

Commands:
  init              Scaffold config, schema template, and snapshot in <dir>
  schema:diff       Diff schema against snapshot → generate .sql migration

Options:
  --dir <path>      Directory for config/schema/snapshot (default: auto-detected
                    from wrangler migrations_dir parent, or "db/")
  --schema <path>   Override schema file path (default: <dir>/schema.ts)
  --help, -h        Show this help message
  --version, -v     Show version

Examples:
  d1-kyt init                        # auto-detect dir (db/ by default)
  d1-kyt init --dir db               # use db/config.ts, db/schema.ts, db/schema.json
  d1-kyt schema:diff create_users
  d1-kyt schema:diff                 # auto-derives name from diff
  d1-kyt schema:diff add_idx --schema src/schema.ts
`;

import type { D1KytConfig } from './config.js';
import { generateMigrationPrefix } from './naming.js';
import { serializeSchema, diffSnapshots, diffToSQL } from './schema-diff.js';
import type { SchemaSnapshot, SchemaDiff } from './schema-diff.js';

// ----------------------------------------------------------------------------
// Wrangler config
// ----------------------------------------------------------------------------

interface WranglerD1Config {
  migrationsDir: string;
}

function readWranglerConfig(): WranglerD1Config | null {
  const wranglerPaths = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

  for (const filename of wranglerPaths) {
    const filepath = resolve(process.cwd(), filename);
    if (!existsSync(filepath)) continue;

    if (filename.endsWith('.toml')) {
      const content = readFileSync(filepath, 'utf-8');
      const match = content.match(/migrations_dir\s*=\s*"([^"]+)"/);
      if (match) return { migrationsDir: match[1] };
    } else {
      const content = readFileSync(filepath, 'utf-8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      try {
        const cfg = JSON.parse(content);
        const d1 = cfg.d1_databases?.[0];
        if (d1?.migrations_dir) return { migrationsDir: d1.migrations_dir };
      } catch {
        // ignore
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Dir resolution
//
// The "dir" is the single folder that holds config.ts, schema.ts, and
// schema.json.  Resolution order:
//   1. --dir <path> flag (explicit)
//   2. Auto-detect an existing config: first d1-kyt/, then parent of
//      wrangler migrationsDir (if it is not the project root)
//   3. Derive a sensible default for init: parent of wrangler migrationsDir
//      (if it has a real parent), otherwise "d1-kyt"
// ----------------------------------------------------------------------------

const CONFIG_FILE = 'config.ts';
const SCHEMA_FILE = 'schema.ts';
const SNAPSHOT_FILE = 'schema.json';
const SCHEMA_SQL_FILE = 'schema.sql';

function toSnake(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
}

function generateDiffName(diff: SchemaDiff): string {
  const parts = [
    ...diff.addedTables.map((t) => `create_${toSnake(t.name)}`),
    ...diff.droppedTables.map((t) => `drop_${toSnake(t.name)}`),
    ...diff.changedTables.map((t) => `alter_${toSnake(t.name)}`),
  ];
  if (parts.length === 0) return 'update_schema';
  if (parts.length <= 3) return parts.join('_and_');
  return 'update_schema';
}

/** Return the absolute path to <dir>/config.ts, or null if no config found. */
function findExistingDir(dirFlag?: string): string | null {
  if (dirFlag) {
    const abs = resolve(process.cwd(), dirFlag);
    return existsSync(join(abs, CONFIG_FILE)) ? abs : null;
  }

  // 1. db/config.ts (default)
  const defaultDir = resolve(process.cwd(), 'db');
  if (existsSync(join(defaultDir, CONFIG_FILE))) return defaultDir;

  // 2. Legacy d1-kyt/config.ts
  const legacy = resolve(process.cwd(), 'd1-kyt');
  if (existsSync(join(legacy, CONFIG_FILE))) return legacy;

  // 3. Parent of wrangler migrations dir (e.g. src/ for src/migrations/)
  const wrangler = readWranglerConfig();
  if (wrangler) {
    const parent = dirname(wrangler.migrationsDir);
    if (parent !== '.') {
      const abs = resolve(process.cwd(), parent);
      if (existsSync(join(abs, CONFIG_FILE))) return abs;
    }
  }

  return null;
}

/** Pick the dir to use for init (before config exists). */
function defaultInitDir(dirFlag?: string): string {
  if (dirFlag) return resolve(process.cwd(), dirFlag);

  const wrangler = readWranglerConfig();
  if (wrangler) {
    const parent = dirname(wrangler.migrationsDir);
    if (parent !== '.') return resolve(process.cwd(), parent);
  }
  return resolve(process.cwd(), 'db');
}

async function readD1KytConfig(dir: string): Promise<D1KytConfig | null> {
  const configPath = join(dir, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    const mod = await import(configPath);
    return mod.default ?? mod.config;
  } catch (err) {
    console.error(`Error importing config:`, err);
    return null;
  }
}

// ----------------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------------

function cmdInit(dirFlag?: string): void {
  const dir = defaultInitDir(dirFlag);
  const relDir = dir.replace(process.cwd() + '/', '');

  const wrangler = readWranglerConfig();
  const migrationsDir = wrangler?.migrationsDir ?? 'db/migrations';

  if (wrangler) {
    console.log(`Detected wrangler migrations_dir: ${migrationsDir}`);
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created: ${relDir}/`);
  }

  // config.ts
  const configPath = join(dir, CONFIG_FILE);
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `import { defineConfig } from 'd1-kyt/config';\n\nexport default defineConfig({\n  migrationsDir: '${migrationsDir}',\n  namingStrategy: 'sequential',\n});\n`,
    );
    console.log(`Created: ${relDir}/${CONFIG_FILE}`);
  } else {
    console.log(`Skipped: ${relDir}/${CONFIG_FILE} (already exists)`);
  }

  // schema.ts
  const schemaPath = join(dir, SCHEMA_FILE);
  if (!existsSync(schemaPath)) {
    writeFileSync(
      schemaPath,
      `import { defineTable, defineIndex, withDefault } from 'd1-kyt';\nimport { createQueryBuilder } from 'd1-kyt';\nimport * as v from 'valibot';\n\n// Define your tables here, then run: d1-kyt schema:diff <name>\n//\n// export const users = defineTable('users', {\n//   email:  v.string(),                                          // TEXT NOT NULL\n//   name:   v.nullable(v.string()),                             // TEXT (nullable)\n//   age:    v.nullable(v.pipe(v.number(), v.integer())),        // INTEGER (nullable)\n//   active: withDefault(v.boolean(), false),                    // INTEGER NOT NULL DEFAULT 0\n//   prefs:  v.nullable(v.object({ theme: v.string() })),       // TEXT JSON (nullable)\n// });\n//\n// export const usersEmailIdx = defineIndex(users, ['email'], { unique: true });\n\n// Add each table to DB, then use \`db\` for type-safe query building.\nexport type DB = {\n  // users: typeof users.$inferSelect;\n};\n\nexport const db = createQueryBuilder<DB>();\n`,
    );
    console.log(`Created: ${relDir}/${SCHEMA_FILE}`);
  } else {
    console.log(`Skipped: ${relDir}/${SCHEMA_FILE} (already exists)`);
  }

  // schema.json
  const snapshotPath = join(dir, SNAPSHOT_FILE);
  if (!existsSync(snapshotPath)) {
    const empty: SchemaSnapshot = { version: 1, tables: {} };
    writeFileSync(snapshotPath, JSON.stringify(empty, null, 2) + '\n');
    console.log(`Created: ${relDir}/${SNAPSHOT_FILE}`);
  } else {
    console.log(`Skipped: ${relDir}/${SNAPSHOT_FILE} (already exists)`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Edit:  ${relDir}/${SCHEMA_FILE}`);
  console.log(`  2. Diff:  d1-kyt schema:diff <name>`);
  console.log(`  3. Apply: wrangler d1 migrations apply <db> --local`);
}

async function cmdSchemaDiff(
  name: string | undefined,
  dirFlag?: string,
  schemaFlag?: string,
): Promise<void> {
  const dir = findExistingDir(dirFlag);
  if (!dir) {
    console.error('Error: d1-kyt not initialized. Run "d1-kyt init" first.');
    if (dirFlag) console.error(`       (looked in: ${dirFlag})`);
    process.exit(1);
  }

  const config = await readD1KytConfig(dir);
  if (!config) {
    console.error(`Error: Could not load config from ${join(dir, CONFIG_FILE)}`);
    process.exit(1);
  }

  // Resolve schema file path
  const schemaPath = schemaFlag
    ? resolve(process.cwd(), schemaFlag)
    : join(dir, SCHEMA_FILE);

  if (!existsSync(schemaPath)) {
    console.error(`Error: Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  // Load schema module
  let schemaExports: Record<string, unknown>;
  try {
    schemaExports = await import(schemaPath);
  } catch (err) {
    console.error(`Error loading schema from ${schemaPath}:`, err);
    process.exit(1);
  }

  // Serialize → diff → SQL
  const currentSnapshot = serializeSchema(schemaExports);

  const snapshotPath = join(dir, SNAPSHOT_FILE);
  let prevSnapshot: SchemaSnapshot = { version: 1, tables: {} };
  const legacyPath = join(dir, 'schema.snapshot.jsonc');
  if (existsSync(snapshotPath)) {
    try {
      prevSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as SchemaSnapshot;
    } catch {
      console.warn(`Warning: Could not parse ${SNAPSHOT_FILE}; treating as empty.`);
    }
  } else if (existsSync(legacyPath)) {
    try {
      const raw = readFileSync(legacyPath, 'utf-8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      prevSnapshot = JSON.parse(raw) as SchemaSnapshot;
    } catch {
      console.warn(`Warning: Could not parse legacy snapshot; treating as empty.`);
    }
  }

  const diff = diffSnapshots(prevSnapshot, currentSnapshot);
  const statements = diffToSQL(diff);

  if (statements.length === 0) {
    console.log('Schema is up to date.');
    return;
  }

  // Write migration file
  const outDir = resolve(process.cwd(), config.migrationsDir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const existingFiles = readdirSync(outDir);
  const strategy = config.namingStrategy ?? 'sequential';
  const prefix = generateMigrationPrefix(strategy, existingFiles);

  const snakeName = name ? toSnake(name) : generateDiffName(diff);

  const filename = `${prefix}_${snakeName}.sql`;
  const sql =
    `-- Generated by d1-kyt schema:diff\n` +
    `-- ${new Date().toISOString()}\n\n` +
    `${statements.join('\n\n')}\n`;

  writeFileSync(join(outDir, filename), sql);
  console.log(`Created: ${config.migrationsDir}/${filename}`);

  // Update snapshot
  writeFileSync(snapshotPath, JSON.stringify(currentSnapshot, null, 2) + '\n');
  const relDir = dir.replace(process.cwd() + '/', '');
  console.log(`Updated: ${relDir}/${SNAPSHOT_FILE}`);

  // Write schema.sql (full DDL from empty → current)
  const fullStatements = diffToSQL(diffSnapshots({ version: 1, tables: {} }, currentSnapshot));
  const schemaSql =
    `-- Generated by d1-kyt schema:diff\n` +
    `-- Full schema as of: ${new Date().toISOString()}\n\n` +
    `${fullStatements.join('\n\n')}\n`;
  writeFileSync(join(dir, SCHEMA_SQL_FILE), schemaSql);
  console.log(`Updated: ${relDir}/${SCHEMA_SQL_FILE}`);

  console.log(`\nRun: wrangler d1 migrations apply <db> --local`);
}

// ----------------------------------------------------------------------------
// Arg helpers
// ----------------------------------------------------------------------------

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    process.exit(0);
  }

  switch (command) {
    case 'init':
      cmdInit(flagValue(args, '--dir'));
      break;

    case 'schema:diff': {
      const maybeName = args[1];
      const name = maybeName && !maybeName.startsWith('--') ? maybeName : undefined;
      await cmdSchemaDiff(name, flagValue(args, '--dir'), flagValue(args, '--schema'));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
