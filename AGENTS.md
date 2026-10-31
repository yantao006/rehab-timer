# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Edit application source in `src/`; `npm run build` generates `index.html`, which must never be hand-edited. Cue texts live only in `RehabCore.VOICE_TEXT` (`src/core.js`); after changing them run `node scripts/generate-voice.mjs` (see `audio/README.md`), then build.
- Run `npm run validate` with Node.js 22.13+ (CI uses 24). Tests execute the shipped scripts from `index.html` and the real API against native SQLite; `npm run build:publish` prepares static upload assets.
- Use ego-browser only, via `file://` or the existing Pages preview. Do not start a local server. Emulation overrides reset per `ego-browser nodejs` run, so set the viewport each time. Test parameters are in `README.md`; test modes use isolated storage and never call the API.
- Timing: one continuous track per item is rendered in the browser (`src/audio.js`) and played by the single retained `<audio>` element; the UI reads `media.currentTime`. The first `play()` must stay synchronous with the tap, so tracks are pre-rendered before any button that needs them is enabled. Silent/debug mode uses a `performance.now()` wall clock over the same timeline.
- Restores never consume offline time. Interrupted holds restart from their beginning (never fewer seconds of work); rests resume where they stopped. Item boundaries and the second manual set require an explicit tap.
- Doses must not drift: tests pin plan A at 104 dose segments / 1520 s (60 s group rest) and plan B at 99 segments. Settle (10 s after each item start) is not part of the dose.
- The UI must never show sync, cloud, conflict or migration state; `tests/page.test.cjs` guards the wording. Records are written locally first and uploaded silently (`src/store.js`); the API is idempotent by `(program, id)`.
- D1 keeps the original `records` / `calendar_adjustments` tables; older tables stay read-only and must not be dropped. Production and preview bindings are separate in `wrangler.jsonc`. The `rehab-timer` Pages project uses direct upload; a merged PR is not proof of deployment.
- Old browser data is carried over once and silently: v2 pending ops, and v1 raw keys only (never test prefixes or projected history). Original keys are preserved.
- Product rules are authoritative in `PRODUCT.md`; visual rules in `DESIGN.md`. Exercise pictograms are placeholder line art pending the user's photos.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
