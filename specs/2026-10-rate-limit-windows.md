# 订阅额度窗口（Claude 5h / 周 + Codex）显示

> 状态：Draft
> 日期：2026-10-12 ｜ 关联 backlog：B-555 ｜ 出处：Orca 对照第二批（Orca 读 `api.anthropic.com/api/oauth/usage`，我们不跟）

## 背景

用户在网页上看不到订阅额度（Claude Pro/Max 的 5 小时窗口与周窗口、Codex 的 5h/周窗口）还剩多少，
经常在长任务中途撞墙才发现。Claude Agent SDK 早就把额度信息作为 `rate_limit_event` 帧发给 wrapper，
但 `sdkToLogConverter.ts` 只把它当生命周期帧丢掉。Codex app-server 也有对应的 `account/rateLimits/*`。

## 目标

1. wrapper 从**已经在跑的** SDK/app-server 流里取额度窗口快照，交给本机 daemon；daemon 合并后写入
   `daemonState.rateLimits`（可选字段，带 `observedAt`），只在变化时上报并节流。
2. Web 侧栏底部显示全账号「最紧的那个窗口」：用量条 + 重置倒计时；机器页显示该机全部窗口。
   手机侧栏抽屉与机器页均可见。>80% 用 `--warn`，>95% 用 `--danger`；数据超过 6 小时弱化并标注观测时间。
3. 旧 CLI 不上报 → Web 什么都不显示、不报错。

## 非目标

- 不调用 Anthropic 非公开 OAuth usage 端点，不读取任何 Claude/Codex 凭据文件。
- 不用 SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`（d.ts 明说不稳定，且它内部就是去拉 usage 端点）。
- Claude **本地模式 / web 终端里的 TUI claude** 不出 SDK 帧，本期不覆盖（后续可走 statusLine 输入，另开项）。
- 不做按账号区分（同机多 `CLAUDE_CONFIG_DIR` 账号时按窗口 last-write-wins，见风险 3）。
- 不改 server（daemonState 对 server 是不透明密文），不加 Prisma migration。
- 可选项「Automation 额度 >95% 时 spawn 类 run 记 skipped `rate_limited`」本期**不做**（见文末「未做」）。

## 数据来源核实（2026-10-12，隔离目录实跑）

### Claude：锁定 SDK `@anthropic-ai/claude-agent-sdk@0.3.296`（内置 Claude Code 2.1.296）

- 公开类型 `SDKRateLimitEvent { type:'rate_limit_event', rate_limit_info: SDKRateLimitInfo }`
  （`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5691`）；`SDKRateLimitInfo` 公开字段
  `status`、`resetsAt?`、`rateLimitType?: 'five_hour'|'seven_day'|'seven_day_opus'|'seven_day_sonnet'|'seven_day_overage_included'|'overage'`、
  `utilization?`（`sdk.d.ts:5704`）。这些顶层字段只描述**当前限流的那个窗口**，`utilization` 只在越过告警阈值时出现。
- 原生二进制（`claude-agent-sdk-darwin-arm64/claude`）里同一帧的 zod schema 还带 **`unifiedWindows`**（标 `@internal`）：
  `{ five_hour?, seven_day?, seven_day_overage_included? }`，各为 `{ utilization: number, resetsAt: int }`。原文描述：
  utilization 是**比例**（通常 0–1，可 >1），resetsAt 是 **unix 秒**；「每次观测都跟踪两个窗口，四舍五入后的百分比或重置时间变化即发事件」；
  API key / Bedrock / Vertex 永远没有。发射侧另有 30s 最小间隔（`minimumIntervalMs` 默认 30000）。
- 实跑（`HAPPY_HOME_DIR=~/code/github/skills/tmp/vh-orca-lessons/b555-scratch/happy-home`，haiku，一轮 `Reply with exactly: ok`）收到：

  ```json
  {"status":"allowed","resetsAt":1791826800,"rateLimitType":"five_hour","overageStatus":"allowed",
   "overageResetsAt":1793491200,"isUsingOverage":false,
   "unifiedWindows":{"five_hour":{"utilization":0.02,"resetsAt":1791826800},
                     "seven_day":{"utilization":0.12,"resetsAt":1792252800}}}
  ```

- 结论：事件**确实**带窗口用量与重置时间 → 采用。主数据取 `unifiedWindows`；顶层 `rateLimitType`+`utilization`
  （告警态才有，可能是 `seven_day_opus` / `seven_day_sonnet`）作为补充窗口合并进来。`unifiedWindows` 是 `@internal`，
  解析一律宽松、逐字段校验，缺失即退回顶层字段，SDK 升级改形状时只会「不显示」，不会报错。

### Codex：本机 `codex-cli 0.154.0`，`codex app-server generate-ts` 生成类型

- `ServerNotification` 含 `{ method: 'account/rateLimits/updated', params: { rateLimits: RateLimitSnapshot } }`；
  `RateLimitSnapshot.primary/secondary: { usedPercent: number, windowDurationMins: number|null, resetsAt: number|null } | null`；
  注释写明这是 **sparse rolling update**：空值不代表清空，应合并进最近一次 `account/rateLimits/read` 结果。
- `ClientRequest` 含 `account/rateLimits/read`（app-server 公开协议，由 codex 用自己的登录去拉，我们不碰凭据）。
- 实跑（ChatGPT team 账号，一轮对话）：`account/rateLimits/updated` 只来了一条且 `primary/secondary` 全为 `null`；
  `account/rateLimits/read` 返回 `primary {usedPercent:0, windowDurationMins:300, resetsAt:1791836601}`、
  `secondary {usedPercent:0, windowDurationMins:10080, resetsAt:1792377533}`。usedPercent 是 0–100，resetsAt 是 unix 秒。
- 结论：只听通知在实测里拿不到任何窗口 → 通知做合并源，另在连接后与每轮结束时调用 `account/rateLimits/read`
  （节流 ≥10 分钟，方法不存在/报错即本进程停用）。**此调用是否保留由主 agent/Owner 拍板**，实现上它是一个独立调用点，删掉即退化为纯通知。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| CLI 锁定 SDK 0.3.296 | `packages/happy-cli/package.json:86` |
| wrapper 用 SDK 自带二进制（未传 `pathToClaudeCodeExecutable`） | `packages/happy-cli/src/claude/sdk/query.ts` |
| `rate_limit_event` 目前只在转日志时被丢弃 | `packages/happy-cli/src/claude/utils/sdkToLogConverter.ts:268` |
| remote 模式所有 SDK 帧都经过 `onMessage` | `packages/happy-cli/src/claude/claudeRemoteLauncher.ts:328` |
| Codex 通知统一入口 `handleNotification`，未处理 rateLimits | `packages/happy-cli/src/codex/codexAppServerClient.ts:1374` |
| wrapper→daemon 走本机 control server，新路由 404/400 时 `daemonPost` 返回 `{error}` 不抛 | `packages/happy-cli/src/daemon/controlClient.ts:20`、`controlServer.ts:526`（`/session-edit` 先例） |
| daemonState 写入是 CAS（`expectedVersion`）+ backoff，有 B-307 速率配额 | `packages/happy-cli/src/api/apiMachine.ts:1207` |
| 连接时 `...currentState` 展开旧 daemonState，未知字段跨重启保留 | `packages/happy-cli/src/api/apiMachine.ts:1315` |
| `DaemonStateSchema` 只用作类型，不做运行时 parse | `packages/happy-cli/src/api/types.ts:287` |
| server 对 daemonState 只存不解析（加密串 + 配额） | `packages/happy-server/sources/app/api/socket/machineUpdateHandler.ts:107` |
| Web 端 `daemonState: any`，字段由各自的宽松解析器读取（先例 `parseClaudeAuth`） | `packages/happy-web-v2/src/sync/storageTypes.ts:316`、`sync/claudeAuth.ts` |
| 侧栏底部 `<footer className="sb-footer">`；手机抽屉同一组件 | `packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:1225` |

## 设计

### 线上形状（`daemonState.rateLimits`，全部可选）

```ts
rateLimits?: {
  v: 1,
  updatedAt: number,                      // ms，daemon 本次写入时间
  providers: Record<string, {             // 'claude' | 'codex'，未来可扩展
    observedAt: number,                   // ms，该 provider 最近一次观测
    status?: string,                      // claude: allowed | allowed_warning | rejected（宽松 string）
    windows: Array<{
      kind: string,                       // five_hour | seven_day | seven_day_opus | seven_day_sonnet |
                                          // seven_day_overage_included | codex 非标准时长: window_<mins>m
      usedPercent: number,                // 0–100，可 >100
      resetsAt: number | null,            // ms epoch
      windowMinutes?: number,
      observedAt: number,                 // ms，该窗口最近一次观测
    }>,
  }>,
}
```

不带账号、邮箱、token、组织 id 等任何身份信息。

### CLI

- 纯函数模块 `src/rateLimits/rateLimitWindows.ts`：
  - `fromClaudeRateLimitInfo(info, now)`：`unifiedWindows.*` → 窗口（utilization×100、resetsAt×1000）；顶层
    `rateLimitType`（非 `overage`）+ `utilization` → 补充窗口；顶层 `status==='rejected'` 且无 utilization → 该窗口记 100%。
    一个窗口都没有时返回 `null`（API key 账号即如此）。
  - `fromCodexRateLimits(snapshot, now)`：只认 `limitId` 为 `null`/`'codex'`；primary/secondary 非 null 才出窗口；
    `windowDurationMins` 300→`five_hour`、10080→`seven_day`，其他 `window_<mins>m`。
  - `mergeRateLimits(current, provider, report, now)`：按 `kind` 合并，新观测覆盖旧观测；丢弃已过 `resetsAt` 的窗口；
    丢弃形状不合法的旧值（容忍降级 daemon 写过的脏数据）。
  - `rateLimitSignature(state)`：`kind:round(usedPercent):round(resetsAt/60s)` 拼接，用于变化检测。
- wrapper：`RateLimitReporter`（每进程一个）。Claude remote `onMessage` 收到 `rate_limit_event` 即 normalize；
  Codex client 收到通知 / read 结果即 normalize；按签名去重后 `POST /rate-limits` 到本机 daemon，fire-and-forget。
- daemon：control server 新路由 `/rate-limits`（宽松 body：`provider` + `windows[]` + `status?`）。
  `ApiMachineClient.reportRateLimits()` 在 `updateDaemonState` 里与**当前** daemonState 合并（daemon 重启后不丢别的 provider），
  签名未变不写；距上次写入 <60s 时排一个尾随写（只保留最新一次），避免多会话并发刷屏和 B-307 配额。

### Web

- 纯函数 `src/sync/rateLimits.ts`：宽松 zod 逐个窗口 `safeParse`，坏条目丢弃不抛；`visibleWindows`（滤掉已重置窗口）、
  `rateLimitTone`（>95 danger、>80 warn、其余 normal）、`isRateLimitStale`（observedAt 超 6h）、`formatResetIn`、
  `tightestRateLimit(machines, now)`（新鲜优先，再按 usedPercent 降序）。
- 侧栏：`RateLimitFooter`（新组件，Sidebar 只挂一行）放在 `sb-footer` 上方，单行：provider · 窗口 · 用量条 · 百分比 · 重置倒计时；
  点击进该机器页。无数据不渲染。
- 机器页：`MachineRateLimits`（新组件，MachineScreen 挂一行），按 provider 分组列出全部窗口。
- 色彩：普通填充 `--text-faint`，告警 `--warn`，危险 `--danger`；不用 `--accent`（不是 live 信号）。陈旧时整体降透明度并显示观测时间。
- 倒计时每 30s 重算，不逐秒刷新、不进 aria-live。

### 被否方案

- **OAuth usage 端点**（Orca 做法）：需读凭据，Owner 明确不跟。
- **SDK `usage_EXPERIMENTAL...`**：不稳定 API，且需要我们主动触发远程拉取。
- **写 session metadata**：额度是账号/机器级而非会话级，多会话会重复写且 Web 要聚合所有会话。
- **写 machine metadata**：metadata 是低频身份信息，会触发 machine 列表重渲染与 metadata 版本竞争；daemonState 本就是运行时数据。

## 兼容矩阵与发布顺序

server 不改，任何 server 版本行为一致（daemonState 不透明转存）。

| CLI(daemon) | CLI(wrapper) | Web | 行为 |
|---|---|---|---|
| 旧 | 旧 | 新 | 无 `rateLimits` 字段 → 侧栏/机器页不渲染，无报错 |
| 旧 | 新 | 新/旧 | wrapper `POST /rate-limits` 得 404 → `daemonPost` 返回 `{error}`，静默；不显示 |
| 新 | 旧 | 新 | 无人上报；若该机曾由新 CLI 写过，旧值保留并随时间变陈旧（>6h 弱化、过了 resetsAt 隐藏） |
| 新 | 新 | 旧 | 旧 Web 不读该字段（daemonState 为 any）→ 无变化 |
| 新 | 新 | 新 | 正常显示 |
| 降级到旧 daemon | — | 新 | 旧 daemon 连接时 `...currentState` 原样带着旧 `rateLimits`；Web 按 observedAt/resetsAt 自然弱化/隐藏 |

- 消息不会因此丢失：新增的是 daemonState 子字段和一条本机 HTTP 路由，不触碰会话消息、enum 或 capabilities。
- 发布顺序：server/Web 先（纯读）→ CLI。任意顺序都安全。回滚：Web 回滚即不显示；CLI 回滚即停止上报。

## 风险

1. `unifiedWindows` 是 SDK `@internal` 字段，可能改名/删除 → 宽松解析 + 顶层字段兜底；只会退化为「告警态才显示」或不显示。SDK 升级时用 `scripts` 外的同款 probe 复核（见上「数据来源核实」）。
2. Codex `account/rateLimits/read` 由 codex 访问 OpenAI 后台 → 节流 10 分钟、失败停用；如 Owner 不接受，删掉调用点即可。
3. 同机多 Claude 账号（不同 `CLAUDE_CONFIG_DIR`）会按窗口互相覆盖 → 接受；文案只说「这台机器最近观测」。
4. 只覆盖 Claude remote(SDK) 与 Codex 会话；纯终端用户看不到 → 接受，非目标已注明。
5. daemonState 每次写入带整份终端列表 → 签名去重 + 60s 节流；额度变化本身每轮最多 1 次。

## 验收标准

- [x] CLI：Claude `rate_limit_event`（含/不含 `unifiedWindows`、rejected、API key 空帧）normalize 单测
- [x] CLI：Codex sparse 通知不清空已有窗口；read 结果正确映射 5h/7d
- [x] CLI：merge 丢弃过期窗口、按 observedAt 覆盖；签名不变不写；60s 节流尾随写
- [x] CLI：`/rate-limits` 路由宽松接收、坏 body 400 不崩；旧 daemon 404 时 wrapper 不抛
- [x] Web：解析器对缺失/坏字段返回空；tone 阈值 80/95；stale 6h；tightest 选择
- [x] Web：侧栏与机器页 1280 / 390(coarse) × 亮/暗真浏览器验收，无横向溢出
- [x] tsc（cli build + web）零错误，相关 vitest 绿，`vite build` 成功，`dist/index.mjs --version` 冒烟

实现期验收记录（2026-10-12，本地 standalone server :3155 + vite :8155 + 隔离 `HAPPY_HOME_DIR` daemon + 自启 Playwright Chromium）：
真实 `spawn` 一个 Claude(haiku) 与一个 Codex 会话 → 机器 daemonState 出现 `claude` five_hour 8% / seven_day 14% 与
`codex` five_hour 0% / seven_day 0%；Claude 那条因 60s 节流晚于 Codex 一次尾随写入，符合设计。
经 `/rate-limits` 注入 86%（Opus）/97.4%（Codex 5h）后，侧栏与机器页在 1280 与 390(coarse) × 亮/暗下：
填充色分别为 `--warn`/`--danger`、普通为 `--text-faint`，`scrollWidth - clientWidth = 0`，侧栏行 32px / coarse 44px；
css-probe 采像素确认 danger 条为红、陈旧行降为中性填充 + 0.6 透明度。

## 留真机验证项

- 真实订阅账号跨 5h 窗口重置后侧栏数字回落（需等窗口自然重置）。
- 额度 >80% / >95% 的真实告警配色（需真实高用量）。

## 未做

- Automation 在额度 >95% 时把 spawn 类 run 记 `skipped: rate_limited`：会碰 B-548 刚合入的 automation 前置检查，
  需要 daemon 内读取合并后的窗口并保持 fail-open；本期时间优先保证上报与显示，留后续单独一项。
