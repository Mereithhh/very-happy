---
name: design
description: Very Happy UI design and visual refactoring. Use when creating or changing App pages, shared components, responsive layouts, loading, branding, Landing, docs, login, or product screenshots. Preserve real features while applying the approved compact workspace style.
---

# Very Happy design

Read `docs/design-language.md` from the repository root before changing UI. It is the sole design authority; `packages/happy-web-v2/src/styles/tokens.css` owns concrete tokens. Do not substitute a fresh style or copy the review prototype's reduced feature set.

- Product direction: compact, content-first workspace inspired by Codex, with the existing Very Happy smile-terminal identity and live connection signals. Public Landing/docs/login must retain deliberate brand expression; workspace density does not mean shrinking public hero sections.
- For a visual migration, inspect actual routes, actions, capability checks, shortcuts and persistence first. Use `specs/2026-09-workspace-entry-audit.md` as an index, then verify current code. Record coverage in `specs/2026-09-workspace-rollout.md`; a pretty fixture is not proof of retained functionality.
- Reuse `ui/` primitives and real feature components. Migrate owners instead of appending a parallel override stylesheet. Delete superseded components/assets only after checking imports and route references; compare production entry/chunk sizes and avoid new dependencies for cosmetic work.
- Verify real rendered pages in light/dark, desktop and 320/390px coarse viewports. Use `scripts/dev/css-probe.mjs` before/after, including pixels for layered decoration. Keep xterm geometry and always-dark behavior separate. Mobile editable controls use 17px; keyboard focus remains visible without external glow.
- Documentation and screenshots must show the implemented UI. Update Landing/docs/README together with user-visible release notes; test workflows from the coverage matrix, not only screenshots. Mark fixtures as examples and do not invent connection/model metrics.

Development and release mechanics remain in `.agents/skills/dev/SKILL.md`, `.agents/skills/release/SKILL.md` and `docs/PROCESS.md`. Design approval is not proof of implementation or deployment.
