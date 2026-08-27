# 会话默认模型真实值标签

> 状态：Final
> 日期：2026-08-27 ｜ 关联 backlog：B-233

## 背景与目标

Web 的 `default model` 只说明没有发送模型覆盖，不代表真实模型名称。Claude SDK 的
`system.init` 已返回实际模型，但 CLI 过去只同步 tools、slash commands、MCP 和 skills。
手机端同时不适合常驻三个会换行的 selector。

- 手机端用一个会话设置入口和底部 Dialog 编辑 model、permission、effort。
- CLI 只在未发送显式模型覆盖时，把 SDK 实际模型写入可选 `defaultModelCode` metadata。
- Web 显示 `<真实值> (default)`；旧 CLI 或首次初始化前显示 `CLI default`，不猜测。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| `modelMode='default'` 映射为 `model:null` | `packages/happy-web-v2/src/sync/messageMeta.ts` |
| SDK init 暴露 `model`，metadata callback 原先未携带 | `packages/happy-cli/src/claude/claudeRemote.ts` |
| Web metadata 是显式 Zod object，字段必须声明 | `packages/happy-web-v2/src/sync/storageTypes.ts` |
| assistant usage 保留实际模型，可作为运行后回退证据 | `packages/happy-web-v2/src/sync/reducer/reducer.ts` |

## 设计与兼容

CLI callback 增加 `model`/`modelIsDefault`；launcher 仅在 `modelIsDefault && model` 时更新
可选 `metadata.defaultModelCode`。Web 标签优先级为 metadata → 最近真实 usage →
`CLI default`。Server 继续把 metadata 当 opaque payload，不增加数据库列。

| 组合 | 行为 |
|---|---|
| 新 Web + 旧 CLI | 初始化前显示 `CLI default`，完成一轮后可使用真实 usage |
| 旧 Web + 新 CLI | 忽略可选字段，发送语义不变 |
| 新 Web + 新 CLI | 默认 query 初始化后显示真实模型 `(default)` |

发布顺序：Web → CLI；两端均可独立回滚，Server 无改动。

## 验收标准

- [x] 手机端只有一个会话设置入口，Dialog 可修改三项。
- [x] 默认 query 写入真实模型；显式 query 不污染默认值。
- [x] 有值显示 `<model> (default)`，无值显示 `CLI default`。
- [x] Web/CLI 单测、build、tsc 与 CLI runtime smoke 通过。

## 留真机验证项

发布后核对实际账号的 SDK 默认模型值与 CLI `/model` 一致。
