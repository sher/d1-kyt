# Changelog

## 0.11.0-rc.1 (2026-07-24)

**Rename** — Project and npm package renamed from `d1-kyt` to `jiku`.

**Feature** — `defineVirtualTable`: typed, migration-free views over real tables.
- A Kysely plugin rewrites queries at the AST level, so a virtual table can be queried with the normal query builder.
- Compose a virtual table from joins of multiple real tables (`left` or `inner`), with columns pulled in from each joined table.
- Supports aliased references, e.g. `selectFrom('X as p')`.
- Throws if a virtual table is used as an insert, update, or delete target, since it is read-only.

## 0.10.5 (2026-06-29)

**Test** — Add missing `queryFirst` boolean coercion tests:
- Auto-deserialization via AST (no explicit table arg): `1 → true`, `0 → false`
- Explicit table arg: add boolean assertion alongside existing JSON assertion
- `withDefault(v.boolean(), ...)`: coercion works through the `withDefault` unwrap path

## 0.10.3 (2026-06-28)

**Fix** — Remove all remaining `v.optional` usages and `'jiku/schema'` import paths that slipped through in 0.10.0:
- `executor.test.ts`: `v.optional` → `v.nullable`
- `cli.ts` init template: updated to `v.nullable` / `withDefault`, import corrected to `'jiku'`
- `schema.ts` JSDoc example: import corrected to `'jiku'`

## 0.10.2 (2026-06-28)

**Fix** — `withDefault`, `WithDefault`, and `AnyColSchema` were not exported from the main entry point. Added to `index.ts` barrel.

## 0.10.1 (2026-06-28)

**Docs** — Updated README and `skills/use-jiku/SKILL.md` to reflect the 0.10.0 API: `withDefault` and `v.nullable` examples throughout, `v.optional` removed.

## 0.10.0 (2026-06-28)

**Breaking change** — `v.optional` is no longer supported as a column schema.

### Migration guide

| Before | After |
|--------|-------|
| `v.optional(v.string())` | `v.nullable(v.string())` |
| `v.optional(v.boolean(), false)` | `withDefault(v.boolean(), false)` |
| `v.optional(v.string(), 'x')` | `withDefault(v.string(), 'x')` |

### What changed

- **New: `withDefault(schema, value)`** — marks a column as `NOT NULL` with a database-level `DEFAULT`. The column is optional on `INSERT` and always present (non-null) on `SELECT`. Infers as `Generated<T>` in Kysely.
- **`v.nullable(schema)`** is now the only way to express a nullable (`NULL`) column. Select type is `T | null`. The column is optional on `INSERT`.
- **`v.optional` removed** — it mapped to JavaScript's `undefined` which has no SQL equivalent, making the inferred TypeScript types (`T | undefined`) semantically wrong for SQL.

---

## 0.9.x and earlier

See git history.
