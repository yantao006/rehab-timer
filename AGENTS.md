# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The application is the self-contained `index.html`; it has no build step or network dependencies.
- Run browser verification through `file://` with ego-browser only.
- Use `?debugMs=100` for a roughly 32-second full-session sequence check, plus the first-work cue handoff after prep; production remains the default when the query is absent.
- Product constraints and visual-system decisions are authoritative in `PRODUCT.md` and `DESIGN.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
