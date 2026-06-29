# Changelog

## 0.10.5 (2026-06-29)

**Test** — Add missing `queryFirst` boolean coercion tests:
- Auto-deserialization via AST (no explicit table arg): `1 → true`, `0 → false`
- Explicit table arg: add boolean assertion alongside existing JSON assertion
- `withDefault(v.boolean(), ...)`: coercion works through the `withDefault` unwrap path

## 0.10.3 (2026-06-28)

**Fix** — Remove all remaining `v.optional` usages and `'d1-kyt/schema'` import paths that slipped through in 0.10.0:
- `executor.test.ts`: `v.optional` → `v.nullable`
- `cli.ts` init template: updated to `v.nullable` / `withDefault`, import corrected to `'d1-kyt'`
- `schema.ts` JSDoc example: import corrected to `'d1-kyt'`

## 0.10.2 (2026-06-28)

**Fix** — `withDefault`, `WithDefault`, and `AnyColSchema` were not exported from the main entry point. Added to `index.ts` barrel.

## 0.10.1 (2026-06-28)

**Docs** — Updated README and `skills/use-d1-kyt/SKILL.md` to reflect the 0.10.0 API: `withDefault` and `v.nullable` examples throughout, `v.optional` removed.

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
