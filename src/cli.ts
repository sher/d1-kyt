#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const VERSION = '0.1.4';

const HELP = `
d1-kyt v${VERSION} - Opinionated Cloudflare D1 + Kysely toolkit

Usage:
  d1-kyt init [--db-dir <dir>]
  d1-kyt migrate:create <name>
  d1-kyt migrate:build
  d1-kyt typegen

Commands:
  init              Initialize d1-kyt/ folder and config
  migrate:create    Create a new migration .ts file
  migrate:build     Compile .ts migrations to .sql
  typegen           Generate TypeScript types (wraps kysely-codegen)

Options:
  --db-dir <dir>    Directory for index.ts (default: db)
  --help, -h        Show this help message
  --version, -v     Show version

Examples:
  d1-kyt init
  d1-kyt init --db-dir src/db
  d1-kyt migrate:create create_users
  d1-kyt migrate:build
  d1-kyt typegen
`;

import type { D1KytConfig } from './config.js';
import { generateMigrationPrefix } from './naming.js';

// ----------------------------------------------------------------------------
// Config Types
// ----------------------------------------------------------------------------

interface WranglerD1Config {
  migrationsDir: string;
}

// ----------------------------------------------------------------------------
// Config Helpers
// ----------------------------------------------------------------------------

const D1_KYT_DIR = 'd1-kyt';
const CONFIG_FILE = 'config.ts';
const KYSELY_CONFIG_FILE = 'kysely-codegen.json';

function getConfigPath(): string {
  return resolve(process.cwd(), D1_KYT_DIR, CONFIG_FILE);
}

function getKyselyConfigPath(): string {
  return resolve(process.cwd(), D1_KYT_DIR, KYSELY_CONFIG_FILE);
}

async function readD1KytConfig(): Promise<D1KytConfig | null> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const module = await import(configPath);
    return module.default ?? module.config;
  } catch {
    return null;
  }
}

function readWranglerConfig(): WranglerD1Config | null {
  const wranglerPaths = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

  for (const filename of wranglerPaths) {
    const filepath = resolve(process.cwd(), filename);
    if (!existsSync(filepath)) continue;

    if (filename.endsWith('.toml')) {
      const content = readFileSync(filepath, 'utf-8');
      const match = content.match(/migrations_dir\s*=\s*"([^"]+)"/);
      if (match) {
        return { migrationsDir: match[1] };
      }
    } else {
      const content = readFileSync(filepath, 'utf-8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

      try {
        const config = JSON.parse(content);
        const d1 = config.d1_databases?.[0];
        if (d1?.migrations_dir) {
          return { migrationsDir: d1.migrations_dir };
        }
      } catch {
        // Invalid JSON
      }
    }
  }

  return null;
}

// ----------------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------------

function cmdInit(dbDir: string): void {
  const wrangler = readWranglerConfig();
  const migrationsDir = wrangler?.migrationsDir ?? 'db/migrations';

  if (wrangler) {
    console.log(`Detected wrangler migrations_dir: ${migrationsDir}`);
  }

  // Create .d1-kyt directory
  const d1KytDir = resolve(process.cwd(), D1_KYT_DIR);
  if (!existsSync(d1KytDir)) {
    mkdirSync(d1KytDir, { recursive: true });
    console.log(`Created: ${D1_KYT_DIR}/`);
  }

  // Create .d1-kyt/migrations
  const srcMigrationsDir = join(d1KytDir, 'migrations');
  if (!existsSync(srcMigrationsDir)) {
    mkdirSync(srcMigrationsDir, { recursive: true });
    console.log(`Created: ${D1_KYT_DIR}/migrations/`);
  }

  // Create .d1-kyt/config.ts
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    const configTemplate = `import { defineConfig } from 'd1-kyt/config';

export default defineConfig({
  migrationsDir: '${migrationsDir}',
  dbDir: '${dbDir}',
  namingStrategy: 'sequential',
});
`;
    writeFileSync(configPath, configTemplate);
    console.log(`Created: ${D1_KYT_DIR}/${CONFIG_FILE}`);
  } else {
    console.log(`Skipped: ${D1_KYT_DIR}/${CONFIG_FILE} (already exists)`);
  }

  // Create .d1-kyt/kysely-codegen.json
  const kyselyConfigPath = getKyselyConfigPath();
  if (!existsSync(kyselyConfigPath)) {
    const kyselyConfig = {
      dialect: 'sqlite',
      excludePattern: '(_cf_|d1_)*',
      outFile: 'generated.ts',
      camelCase: true,
    };
    writeFileSync(kyselyConfigPath, JSON.stringify(kyselyConfig, null, 2) + '\n');
    console.log(`Created: ${D1_KYT_DIR}/${KYSELY_CONFIG_FILE}`);
  } else {
    console.log(`Skipped: ${D1_KYT_DIR}/${KYSELY_CONFIG_FILE} (already exists)`);
  }

  // Create db directory
  const absoluteDbDir = resolve(process.cwd(), dbDir);
  if (!existsSync(absoluteDbDir)) {
    mkdirSync(absoluteDbDir, { recursive: true });
    console.log(`Created: ${dbDir}/`);
  }

  // Create db/index.ts with useTable helper
  const indexPath = join(absoluteDbDir, 'index.ts');
  if (!existsSync(indexPath)) {
    const template = `import type { DB } from '../generated';
import { createUseTable } from 'd1-kyt/migrate';

export const useTable = createUseTable<DB>();
`;
    writeFileSync(indexPath, template);
    console.log(`Created: ${dbDir}/index.ts`);
  } else {
    console.log(`Skipped: ${dbDir}/index.ts (already exists)`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Create migration: d1-kyt migrate:create <name>`);
  console.log(`  2. Build migrations: d1-kyt migrate:build`);
  console.log(`  3. Apply migrations: wrangler d1 migrations apply <db> --local`);
  console.log(`  4. Generate types: d1-kyt typegen`);
}

async function cmdMigrateCreate(name: string): Promise<void> {
  const config = await readD1KytConfig();
  if (!config) {
    console.error('Error: d1-kyt not initialized. Run "d1-kyt init" first.');
    process.exit(1);
  }

  const srcDir = resolve(process.cwd(), D1_KYT_DIR, 'migrations');
  const outDir = resolve(process.cwd(), config.migrationsDir);
  const strategy = config.namingStrategy ?? 'sequential';

  // Collect existing files for sequential numbering
  const existingSql = existsSync(outDir) ? readdirSync(outDir) : [];
  const existingTs = existsSync(srcDir) ? readdirSync(srcDir) : [];
  const existingFiles = [...existingSql, ...existingTs];

  const prefix = generateMigrationPrefix(strategy, existingFiles);

  const snakeName = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();

  const filename = `${prefix}_${snakeName}.ts`;
  const filepath = join(srcDir, filename);

  const template = `import { defineTable, createIndex } from 'd1-kyt/migrate';

// Migration: ${snakeName}
// Created: ${new Date().toISOString().split('T')[0]}

export const migration = () => {
  // Example:
  // const User = defineTable('User', (col) => ({
  //   email: col.text().notNull(),
  //   name: col.text(),
  // }));
  //
  // return [
  //   ...User.sql,
  //   createIndex(User, ['email'], { unique: true }),
  // ];

  return [];
};
`;

  writeFileSync(filepath, template);
  console.log(`Created: ${D1_KYT_DIR}/migrations/${filename}`);
  console.log(`\nEdit the file, then run: d1-kyt migrate:build`);
}

async function cmdMigrateBuild(): Promise<void> {
  const config = await readD1KytConfig();
  if (!config) {
    console.error('Error: d1-kyt not initialized. Run "d1-kyt init" first.');
    process.exit(1);
  }

  const srcDir = resolve(process.cwd(), D1_KYT_DIR, 'migrations');
  const outDir = resolve(process.cwd(), config.migrationsDir);

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Match sequential (3-4 digit) and timestamp (14 digit) patterns
  const tsFiles = readdirSync(srcDir)
    .filter((f: string) => /^\d{3,14}_.*\.ts$/.test(f))
    .sort();

  if (tsFiles.length === 0) {
    console.log('No migration files to build.');
    return;
  }

  let built = 0;
  for (const tsFile of tsFiles) {
    const sqlFile = tsFile.replace(/\.ts$/, '.sql');
    const sqlPath = join(outDir, sqlFile);

    // Skip if .sql already exists
    if (existsSync(sqlPath)) {
      continue;
    }

    const tsPath = join(srcDir, tsFile);

    try {
      // Dynamic import the migration file
      const module = await import(tsPath);
      const statements: string[] = module.migration();

      if (statements.length === 0) {
        console.log(`Skipped: ${tsFile} (empty migration)`);
        continue;
      }

      const sql = `-- Generated by d1-kyt from ${tsFile}\n-- ${new Date().toISOString()}\n\n${statements.join('\n\n')}\n`;
      writeFileSync(sqlPath, sql);
      console.log(`Built: ${config.migrationsDir}/${sqlFile}`);
      built++;
    } catch (err) {
      console.error(`Error building ${tsFile}:`, err);
      process.exit(1);
    }
  }

  if (built === 0) {
    console.log('All migrations already built.');
  } else {
    console.log(`\nBuilt ${built} migration(s). Run: wrangler d1 migrations apply <db> --local`);
  }
}

function cmdTypegen(): void {
  const kyselyConfigPath = getKyselyConfigPath();

  if (!existsSync(kyselyConfigPath)) {
    console.error('Error: d1-kyt not initialized. Run "d1-kyt init" first.');
    process.exit(1);
  }

  console.log('Running kysely-codegen...');

  try {
    execSync(`npx kysely-codegen --config-file "${kyselyConfigPath}"`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  } catch {
    process.exit(1);
  }
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
    case 'init': {
      let dbDir = 'db';
      const dbDirIdx = args.indexOf('--db-dir');
      if (dbDirIdx !== -1 && args[dbDirIdx + 1]) {
        dbDir = args[dbDirIdx + 1];
      }
      cmdInit(dbDir);
      break;
    }

    case 'migrate:create': {
      const name = args[1];
      if (!name) {
        console.error('Error: Migration name required');
        console.error('Usage: d1-kyt migrate:create <name>');
        process.exit(1);
      }
      await cmdMigrateCreate(name);
      break;
    }

    case 'migrate:build':
      await cmdMigrateBuild();
      break;

    case 'typegen':
      cmdTypegen();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
