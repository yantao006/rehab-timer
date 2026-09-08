# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Application logic is in `index.html`; fixed local recordings are in `audio/`. No build step or external runtime service. Deploy both together; asset source/license and regeneration live in `audio/README.md`.
- Run `node --test tests/rehab.test.cjs`; tests execute the actual inline domain script, without dependencies.
- Use ego-browser only, via `file://` or the existing Pages preview. Do not start a local server. Test parameters and acceptance steps are in `README.md`; all test progress/history must remain separate from production.
- The clock uses absolute monotonic boundaries, not callback counts. Late callbacks pause conservatively. Restore never consumes offline time; stage boundaries require manual continuation.
- One retained HTML media element owns speech and beeps. First play must stay synchronous with the user gesture. Decoder events prove neither physical audibility nor iOS compatibility; see `README.md` for sound acceptance.
- The existing `rehab-timer` Pages project uses direct upload, not Git integration. See `README.md` for publication boundaries; a merged PR is not proof of production deployment.
- Product constraints and visual-system decisions are authoritative in `PRODUCT.md` and `DESIGN.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
