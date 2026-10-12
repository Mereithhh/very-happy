# Automation precheck：公开文档同步与 Web 真浏览器验收

> 状态：Final（B-548 收尾，实现 agent 起草；纯文档 + UI 验收，无协议变更）
> 日期：2026-10-12 ｜ 关联 backlog：B-560 ｜ 前身：[Automation precheck](2026-10-automation-precheck.md)（B-548，#489）

## 背景

B-548 合入时漏了两项：公开文档页 `/docs/automations` 没有 precheck / 跳过原因 / ×N 合并 / 旧 CLI 兼容说明；
Web `/automations` 的 precheck 表单、详情页 precheck 卡与运行列表 ×N 没有做 1280 / 390（coarse）× 亮/暗 真浏览器验收
（B-548 spec「留真机验证项」写的是「由主 agent 集成验收时补」）。

## 目标

1. `publicContent.ts` + `publicContent.zhHans.ts` 的 automations 文档新增 precheck 一节（中英同构），内容与
   `docs/automations.md` 一致：用法、四类跳过原因与是否提示、定时跳过 ×N 合并（fire/manual 不合并）、旧 CLI 兼容。
2. 契约测试 `publicContent.test.ts` 钉住上述关键句。
3. 本地 server + vite + 隔离 daemon 造数据（precheck 通过 / 非 0 跳过 / 超时 / 旧 CLI 不支持 / 连续跳过 ×N），
   1280 与 390 coarse × 亮/暗截图；发现的溢出、<44px 触屏目标、<16px 输入字号、token 误用就地修并补测试。

## 非目标

- 不改 wire / server / CLI 行为，不加 migration，不改 `docs/automations.md` 已有语义（只在发现与实现不符时修正）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 公开文档内容源是 TS 常量，`/docs/:slug` 渲染 | `packages/happy-web-v2/src/screens/public/publicContent.ts` `PUBLIC_DOCS`、`DocsScreen.tsx` |
| 中文按 section/block 下标覆盖，`code` 块不翻译（zh 填 `null`），list 整组替换 | `publicContent.ts` `buildZhHansDocs` |
| 契约测试要求 automations 中英 section 数相等、标题不同 | `publicContent.test.ts` "documents Automations in both languages…" |
| 跳过原因码与 Web 文案 | `automationPresentation.ts` `skipReasonKind`；`text/_default.ts` `skipPrecheck*` |
| ×N 只来自 `occurrenceCount>1`，server 只折叠 `schedule` 来源 | `automationPresentation.ts` `occurrenceLabel`；`specs/2026-10-automation-precheck.md` §连续跳过合并 |

## 设计

在「Create one from the web, the CLI or a session」之后插入一节「Precheck: only run when there is something to do」：
段落（是什么）+ CLI 代码块 + 要点列表（命令形态、目录、超时、输出、跳过原因、×N）+ note（兼容：旧 CLI 永不执行带
precheck 的动作，记 *CLI too old* 跳过并提示一次；新 CLI 连不支持 precheck 的旧 server 会拒绝创建/编辑）。
「从网页创建」段补一句表单里的「前置检查（可选）」分组。

## 兼容矩阵与发布顺序

本次无协议/存储变更；公开文档随 server/Web 同镜像发布。文档描述的是 B-548 已上线的矩阵：

| 组合 | 文档表述 |
|---|---|
| 新 server/Web + 新 CLI | 完整功能 |
| 新 server/Web + 旧 CLI | 带 precheck 的 run 不派给旧 daemon，记 skipped「CLI 太旧」+ 提示一次，后续同因 ×N；动作永不执行 |
| 旧 server + 新 CLI | 带 precheck 的 create 被检测并删除、报错「升级 server」；edit 报错；无 precheck 的 automation 不变 |
| 旧 Web | 不存在（同镜像） |

发布顺序：随下一次 server/Web 镜像发布；无 CLI 发布需求。回滚：回滚镜像即恢复旧文档，无数据影响。

## 风险

1. 文档与实现漂移：契约测试钉关键句（`precheck_unsupported_cli` 语义、`×N` 仅 schedule、默认 60s/上限 10m/4000 字符）。
2. UI 修复波及其他 automation 页面：只改 `screens/automations/**` 内样式，附 css-probe 前后证据。

## 验收标准

- [ ] `/docs/automations` 中英都有 precheck 一节，契约测试覆盖。
- [ ] web vitest（public + automations）、tsc、vite build 通过。
- [ ] 1280 / 390 coarse × 亮/暗 截图：列表、表单（precheck 展开）、详情（precheck 卡 + 四种跳过原因 + ×N）、公开文档页。
- [ ] 发现的 UI 问题已修并有测试。

## 留真机验证项

- 无（触屏尺寸以 coarse pointer 模拟 + 计算样式取证；真机 IME 与本次无关）。
