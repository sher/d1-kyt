# kyt

Typed schema, migrations, and query builder, built on [Kysely](https://kysely.dev/) and [Valibot](https://valibot.dev/).

| Package | Database | Folder |
|---|---|---|
| [`kyt-d1`](https://www.npmjs.com/package/kyt-d1) | Cloudflare D1 | [`packages/kyt-d1`](packages/kyt-d1) |
| [`kyt-pg`](https://www.npmjs.com/package/kyt-pg) | Postgres, with postgres.js | [`packages/kyt-pg`](packages/kyt-pg) |

`kyt-d1` was called `d1-kyt` until 0.11.0.

## Releasing

1. In a PR, bump `version` in the package's `package.json` and add a `## <version>` entry to its `CHANGELOG.md`.
2. Merge the PR.
3. In GitHub, open Actions, then Publish, then Run workflow. Pick `kyt-d1`, `kyt-pg` or `both`. Tick `dry_run` to try it without publishing.

The workflow runs every test, then publishes to npm with trusted publishing, so it needs no npm token. A version that is already on npm is skipped. For each new version, it creates a tag and a GitHub Release, such as `kyt-pg@0.1.2`, with that version's CHANGELOG entry as the notes.

Each package needs one setting on npmjs.com, under Settings, then Trusted publishing, then GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `sher` |
| Repository | `kyt` |
| Workflow filename | `publish.yml` |
| Environment | leave empty |
