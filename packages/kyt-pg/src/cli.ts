#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { cmdInit, cmdSchemaDiff, parseRenameFlag } from './cli-commands.js';
import type { CliIO } from './cli-commands.js';
import type { Rename } from './diff.js';

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }
).version;

const HELP = `
kyt-pg v${VERSION} - Opinionated Postgres + Kysely toolkit

Usage:
  kyt-pg init [--dir <dir>]
  kyt-pg schema:diff [name] [--dir <dir>] [--schema <path>] [--rename <x>]... [--no-rename]

Commands:
  init              Add config, schema template and snapshot in <dir>
  schema:diff       Compare the schema with the snapshot and write a .sql migration

Options:
  --dir <path>      Folder for config, schema and snapshot (default: "db")
  --schema <path>   Schema file path (default: <dir>/schema.ts)
  --rename <x>      Confirm a rename. Use <Table>=<NewTable> or <Table>.<old>=<new>.
                    Repeat the flag for each rename.
  --no-rename       Treat every possible rename as a drop and an add
  --help, -h        Show this help message
  --version, -v     Show the version

Examples:
  kyt-pg init
  kyt-pg schema:diff createUser
  kyt-pg schema:diff --rename User.name=fullName
`;

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => {
    if (arg === flag && args[i + 1] !== undefined) values.push(args[i + 1]);
  });
  return values;
}

function createIO(): CliIO {
  return {
    cwd: process.cwd(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`${question} `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  const io = createIO();
  switch (command) {
    case 'init':
      cmdInit(io, { dir: flagValue(args, '--dir') });
      return 0;

    case 'schema:diff': {
      let renames: Rename[];
      try {
        renames = flagValues(args, '--rename').map(parseRenameFlag);
      } catch (err) {
        console.error((err as Error).message);
        return 1;
      }
      const maybeName = args[1];
      const name = maybeName && !maybeName.startsWith('--') ? maybeName : undefined;
      return cmdSchemaDiff(io, {
        name,
        dir: flagValue(args, '--dir'),
        schema: flagValue(args, '--schema'),
        renames,
        noRename: args.includes('--no-rename'),
      });
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
