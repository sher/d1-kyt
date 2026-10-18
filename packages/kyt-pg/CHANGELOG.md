# Changelog

## 0.1.0 (2026-10-18)

First release.

- Define tables, indexes, triggers and foreign keys with Valibot.
- Add typed Kysely queries that only compile. postgres.js runs them.
- Add read-only virtual tables.
- Add `queryAll`, `queryFirst`, `queryRun` and `queryBatch`.
- Add the `kyt-pg` command with `init` and `schema:diff`.
- Ask about renames, or pass `--rename` and `--no-rename`.
- Add warnings for changes that can fail on a table with rows.
- Add `migrate` in `kyt-pg/migrate`. It uses one transaction for each file and an advisory lock.
