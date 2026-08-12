# very-happy 迭代流程（Iteration Process）

> 单人产品 Owner（jojo）+ AI agent 集群的开发模式。本流程不是理想主义 SOP，
> 是 2026-08 大规模迭代（v0.2.20→28，30+ 次发布）中实际有效工作流的固化。
> 修订本文档 = 修订流程本身。

## 0. 角色模型

- **Owner（jojo）**：出需求/实报 bug/拍板取舍/真机验收。
- **主 agent（Claude 会话）**：triage、拆分、派工、review、合并、发布、沉淀。
- **实现 agent（sub-agent × worktree）**：单一职责实现，交付"报告 + 分层 commit"。
- 边界纪律：并行 agent 各占 worktree；同文件冲突由主 agent 合并时解决；
  高冲突热区（SettingsRoutes/WebTerminalScreen）派工时显式声明"别碰"。

## 1. 输入 → Backlog

- 全部输入（实报 bug / 想法 / 评审发现 / 技术债）进 **`docs/backlog.md`**（一项一行，
  类型 `bug`/`ux`/`feat`/`debt`）；留真机验证项另进 **`docs/verify-queue.md`**。
  > 2026-08 修订：原定 GitHub Issues，实证零使用（零 issue 零 label）后改文件化——
  > 状态与代码同 commit、agent 零网络凭据可读写、可 grep；理由详见 backlog.md 头注。
- **单写者纪律**：backlog.md 只由主 agent（或 Owner）写；Owner 在对话里说的需求，
  主 agent 当场记入（不靠记忆）；实现 agent 只读不写。
- 产品内 task board 管"会话/任务运行态"，backlog.md 管"产品迭代项"——两者不混。

## 2. 批次制（Release Train）

以**批**为单位迭代，一批 = 2-6 个独立事项：

```
triage（分独立/冲突域）
  → 并行实现（每事项一个 worktree + 分支；大改动先出 spec 定稿，见 specs/README.md）
  → 主 agent 逐个 review + merge（含冲突解决）
  → 集成门禁（见 §3）
  → 发布（见 §4）
  → 验收（自动化 E2E + 真机清单登记 docs/verify-queue.md）
  → 沉淀（见 §6）
```

- **大改动前置设计**：动协议/状态模型/存储语义的（如推送化、seq 记账），
  先由 Plan agent 出 spec（`specs/`，模板与生命周期见 `specs/README.md`）、
  主 agent 定稿，再派实现。小改直接做。spec shipped 后回标状态，留档不删。
- **每批结束跑一次 high-effort code-review 全量回扫**（对本批 diff）：
  2026-08 实证一次回扫抓出 11 个 CONFIRMED 真问题。发现项当场修或建 issue。

## 3. 质量门禁（硬性，任何 merge 前）

| 包 | 门禁 |
|---|---|
| happy-web-v2 | `pnpm exec vitest run` 全绿 + `pnpm exec vite build` 成功 + **`pnpm exec tsc --noEmit` 0 错误**（存量债 2026-08-13 清零，CI 硬门） |
| happy-cli | `pnpm build` + unit 全绿（daemon.integration "second daemon" 为已知环境例外）+ `node dist/index.mjs --version` 运行冒烟（build 绿 ≠ 运行不崩，有 CJS 事故先例） |
| happy-server | `tsc --noEmit` + `vitest run` 全绿（**零新 npm 依赖**——bind-mount 约束） |

通用纪律：
- **事故必附回归测试**：修复不带覆盖该机制的测试不许合并。
- 纯函数优先：新逻辑尽量抽纯函数模块（`termWriteHold`/`termStreamSync`/`boardTaskOps` 模式），
  这是 AI 并行开发下测试稳定性的支柱。
- 推公开 remote 前 gitleaks（或等价 secret 扫描）；密钥永不进 repo。
- 工具用 `pnpm exec`（npx 会解析到错误版本）。

## 4. 发布工程

- **版本**：CLI = semver patch（推 tag 自动发 npm）；web = bundle salt 随每次部署；server 随源同步。
- **发布顺序**：默认 server → web → CLI（tag → npm 200 → `vh-update`）；
  涉及协议字段时按实现报告里的兼容矩阵定顺序，**双向兼容（旧端忽略新字段）是设计要求**不是可选项。
- **部署核对**：push 后 ≥20s 再触发 CI；`gh run view --json headSha` 核对构建 sha = 预期 commit
  （踩过构建到旧 commit、push 静默失败两种事故）。
- **回滚**：CLI = `npm i -g very-happy-cli@<上一版>` + 重启；web = hw-sg `webapp.prev` 或重发上一 sha；
  server = git revert + 重部署。每批发布信息里写明本批的回滚点。
- **server 部署后必须 vh-update**（daemon RPC 重注册的已知问题，未根治前是流程项）。

## 5. 验收

- **自动化能验的当批验掉**（E2E 冒烟：spawn/send/webhook/剪贴板链路都有先例脚本手法）。
- **自动化验不了的**（真机 IME/触屏/视觉观感）：当批产出「留真机验证」清单 →
  登记 `docs/verify-queue.md`，**下一批开始前先清账**——不许无限堆积；
  验证不通过当场转 backlog.md 建 bug 项。
- 浏览器验证注意 SW 缓存混版（硬刷新/unregister 后再判断"没生效"）。

## 6. 沉淀（每批必做）

- repo 内落账：`docs/backlog.md` 本批做完的项标 done 移入「近期完成」；
  留真机验证项登记 `docs/verify-queue.md`；本批的 spec 回标 Shipped + commit。
- `skills/happy/references/very-happy-build-state.md` 追加本批节（现状、根因、教训、版本号）。
- 稳定事实变更同步 `skills/happy/SKILL.md`；设计 token 变更同步 design-tokens.md。
- 新坑进"坑"清单——判据：下个 agent 不知道会再踩的，才值得写。

## 7. 健康度（轻量，每月看一眼）

- tsc 存量债趋势（只减不增红线）、测试用例总数、web 初始 bundle 大小、
  发布频率与回滚次数。异常再深挖，不做仪表盘。

## 8. 节奏建议

- 集中批（像 2026-08-12 这种连发日）适合攻坚；平时以**周为默认批周期**，
  紧急 bug 走单事项快速批（一样过全部门禁，只是批小）。
- 每 4-6 批做一次**架构层评审**（对全库，不对 diff），滚动更新技术债判定
  （现在修 / 等触发条件 / 永远不修 三档）。
