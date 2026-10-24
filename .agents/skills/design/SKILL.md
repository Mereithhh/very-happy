---
name: design
description: Very Happy UI design and visual refactoring. Use when creating or changing App pages, shared components, responsive layouts, loading, branding, Landing, docs, login, or product screenshots. Preserve real features while applying the approved compact workspace style.
---

# Very Happy design

Read `docs/design-language.md` from the repository root before changing UI. It is the sole design authority; `packages/happy-web-v2/src/styles/tokens.css` owns concrete tokens. Do not substitute a fresh style or copy the review prototype's reduced feature set.

- Product direction: compact, content-first workspace inspired by Codex, with the Very Happy reverse-video `^_^` block mark (B-724; rules in design-language §Logo) and live connection signals. Public Landing/docs/login must retain deliberate brand expression; workspace density does not mean shrinking public hero sections.
- Surfaces, borders and depth follow `docs/design-language.md` §2.1 (CDS-derived, B-614): the 1-Border Rule (at most one closed outline per line of sight — no card wrapping a card), the surface/alpha ladder, radius/motion tokens and the shared atoms in `src/styles/surfaces.css` (`.vh-panel`, `.vh-pill`, `.vh-segmented`). Run `node scripts/dev/nesting-audit.mjs --base <dev-server>` (target 0 violations) before shipping UI that adds borders.
- For a visual migration, inspect actual routes, actions, capability checks, shortcuts and persistence first. Use `specs/2026-09-workspace-entry-audit.md` as an index, then verify current code. Record coverage in `specs/2026-09-workspace-rollout.md`; a pretty fixture is not proof of retained functionality.
- Reuse `ui/` primitives and real feature components. Migrate owners instead of appending a parallel override stylesheet. Delete superseded components/assets only after checking imports and route references; compare production entry/chunk sizes and avoid new dependencies for cosmetic work.
- Verify real rendered pages in light/dark, desktop and 320/390px coarse viewports. Use `scripts/dev/css-probe.mjs` before/after, including pixels for layered decoration. Keep xterm geometry and always-dark behavior separate. Mobile editable controls use 16px; keyboard focus remains visible without external glow.
- Touch (design-language §6 U1–U3, B-798): long-press is only a shortcut — every `ActionContextMenu` row also shows a ⋯ over the same items; hide row actions only inside `@media (hover: hover) and (pointer: fine)` (visible by default); touch targets are 44×44 (widen small visuals with an absolute `::after`). Gates: lint `hover-reveal-needs-touch` / `touch-target`, `src/ui/touchParity.test.ts`, and `scripts/dev/device-shots.mjs` (`smallTargets` / `hiddenActions` against `scripts/dev/touchGate.mjs`).
- Documentation and screenshots must show the implemented UI. Update Landing/docs/README together with user-visible release notes; test workflows from the coverage matrix, not only screenshots. Mark fixtures as examples and do not invent connection/model metrics.

## 界面审查清单

审查界面、截图或原型时（包括 review 别人的 UI PR），逐条对照 `docs/design-language.md` 检查：配色语义、对话区字号、§6 的反馈时机、组件选择、文案规则，以及相邻组件是否一致。还要跑 `node scripts/dev/check-design-lint.mjs --base <PR base>`。结论按下面的顺序输出，每条都点名具体元素，不写泛泛的评价：

1. **最该改的 3 处**：按对用户的影响排序。
2. **摩擦点**：杂乱、没对齐、文案问题、焦点问题、流程多出来的步骤、违反 design-language 的地方，各自写明所在元素和对应条款。
3. **具体改法**：写到布局、层级、控件、文案、空状态和错误态、渐进展开这一层，能直接照着实现，并标出复用哪个现有组件。
4. **键盘与步数**：常用流程能不能 1–2 步完成；默认焦点是否落在最可能用到的字段或主操作上；Enter 是否触发预期的主操作（破坏性确认不响应 Enter）；Esc 能否安静地退出。
5. **缺失的外链与恢复路径**：错误或空状态有没有直接的获取、配置、重试入口，以及文档、设置页链接；需要阅读或重试的错误是否常驻在行内，而不是只弹一个 toast。

Development and release mechanics remain in `.agents/skills/dev/SKILL.md`, `.agents/skills/release/SKILL.md` and `docs/PROCESS.md`. Design approval is not proof of implementation or deployment.
