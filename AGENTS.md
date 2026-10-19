# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Edit application source in `src/`; `npm run build` generates `index.html`, which must never be hand-edited. Fixed recordings remain in `audio/`; source/license and regeneration live in `audio/README.md`.
- Run `npm run validate` with Node.js 22.13+ (CI uses 24). Tests execute the shipped domain/controller and real repository/API against native SQLite; `npm run build:publish` prepares static upload assets.
- Use ego-browser only, via `file://` or the existing Pages preview. Do not start a local server. Test parameters and acceptance steps are in `README.md`; all test progress/history must remain separate from production.
- Standard timing follows continuous stage audio; fallback/debug timing uses absolute monotonic boundaries, not callback counts. Restore never consumes offline time; stage boundaries and the second manual group require explicit continuation.
- One retained HTML media element owns speech and beeps. First play must stay synchronous with the user gesture. Decoder events prove neither physical audibility nor iOS compatibility; see `README.md` for sound acceptance.
- The existing `rehab-timer` Pages project uses direct upload, not Git integration. See `README.md` for publication boundaries; a merged PR is not proof of production deployment.
- D1 is authoritative, with independent production/preview bindings in `wrangler.jsonc`. Shared records are open without login; `SESSION_SECRET` only signs session write-ownership tokens. Keep local outbox completion independent of current progress; idempotent acknowledgments must not regress newer revisions or revocations.
- Migrate raw v1 keys only through the backup/preview/import flow. Never migrate the old Store.history projection or test prefixes; preserve raw originals and constrain date overrides to explicitly imported record IDs. See `docs/sync-api.md`.
- Product constraints and visual-system decisions are authoritative in `PRODUCT.md` and `DESIGN.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
