# CLI / daemon 更新提示

> 状态：Final
> 日期：2026-08-25 ｜ 关联 backlog：B-040

## 背景

Web 发版能由 service worker 与 bundle hash 自动迁移，但机器侧能力由长驻
daemon 提供。产品持续迭代时，旧 daemon 会缺 RPC/协议能力，目前只有功能失败
后的局部“请升级”，没有主动、统一、可 dismiss 的版本提示。

## 目标

- relay 发布当前 `very-happy-cli` 的 recommended/minimum 版本政策。
- daemon 低频获取政策，把结果写入本地 state 与已有加密 machine daemonState。
- Web 对每台机器分为 current / available / required，并给出精确版本的升级命令。
- `very-happy daemon status` / `doctor` 展示 installed CLI、running daemon 及版本政策，
  明确指出 CLI/daemon 不一致。
- 旧 server / 旧 daemon / 旧 Web 任意组合不回归。

## 非目标

- 不让 daemon 静默执行 npm，不从 server 下发或执行 shell 命令。
- 不在 Web 伪装“一键升级”；首版只复制固定包名 + 精确版本的命令。
- 不改变现有 bundle mtime 驱动的 daemon 交接机制。
- 不因 minimum 过旧强杀正在运行的会话；功能级硬门禁仍由各功能的
  兼容性检查负责。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| daemon 已将运行 bundle 版本上报为 `MachineMetadata.happyCliVersion` | `packages/happy-cli/src/daemon/run.ts:52-63` |
| daemon local state 记录 `startedWithCliVersion` | `packages/happy-cli/src/daemon/run.ts:1064-1080` |
| 安装替换 bundle 后 daemon 每 60s 检测 mtime 并交接到新进程 | `packages/happy-cli/src/daemon/run.ts:1082-1095,1180-1223` |
| 当前 CLI 与运行 daemon 的版本可由 bundle 内嵌版本和 state 可靠比较 | `packages/happy-cli/src/daemon/controlClient.ts:236-266` |
| server 已有匿名 version routes，但仅处理废弃 native iOS/Android 更新 | `packages/happy-server/sources/app/api/routes/versionRoutes.ts:1-45` |
| Web 已有 device-local `acknowledgedCliVersions: machineId -> version` | `packages/happy-web-v2/src/sync/localSettings.ts:25-26` |
| Web machine 详情已显示 daemon 运行版本 | `packages/happy-web-v2/src/screens/machine/MachineScreen.tsx:234-257` |
| 旧 `dismissedCLIWarnings` 是 agent CLI 缺失提示且含 synced zod defaults，不得复用 | `packages/happy-web-v2/src/sync/settings.ts:147-160` |

## 设计

### 1. Relay 版本政策

新增匿名 `GET /v1/version/cli`：

```json
{
  "recommendedVersion": "0.2.68",
  "minimumVersion": "0.2.34",
  "checkedAt": 1787620000000,
  "source": "configured"
}
```

- `CLI_RECOMMENDED_VERSION` 可精确 pin recommended；`CLI_MINIMUM_VERSION` 可选。
- recommended 未配置且 operator 显式设置 `CLI_VERSION_REGISTRY_LOOKUP=true` 时，server
  才以固定 HTTPS npm registry URL 查询 `very-happy-cli/latest`；只接受合法 semver，
  成功缓存 1h，失败至少退避 5min 并返回上次成功值；无缓存则返回 null，不阻断业务。
- `CLI_VERSION_REGISTRY_LOOKUP` 默认 `false`，self-hosted 默认无版本查询出站。
- response 不包含 URL/命令/包名等可执行数据。

### 2. Daemon 检测与上报

daemon 在 machine socket 就绪后立即检查，之后每 6h 检查（环境变量错误时回退 6h，
最短 5min）；请求 2s 超时。
成功结果写入：

- local `daemon.state.json.cliUpdate`，供 CLI status/doctor 零网络读取；
- encrypted `daemonState.cliUpdate`，供 Web 消费。

shape 为 `{ currentVersion, recommendedVersion, minimumVersion, status, checkedAt }`，status 为
`current | available | required`。同一进程的短时失败保留本地最后成功状态；新 daemon 进程
若遇到旧 server/失败，会在 connect snapshot 中移除上一代 encrypted cliUpdate，避免陈旧提示。

### 3. Web UX

- authenticated route shell 挂一个全局非模态 banner，汇总在线机器中最高 severity；不用 accent
  表示“有更新”（accent 只表示 live）。
- available 可按机器 + target version dismiss；新 target 自动重现。required 不被普通
  dismiss 永久隐藏。
- CTA 复制 `npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@<exact>`，
  另一个 CTA 进入 diagnostics/machine detail。
- machine 详情和 diagnostics 显示 running/recommended/minimum/status。

### 4. CLI UX

`daemon status` 和 `doctor` 只读 local state，显示 installed CLI 与 running daemon；不一致时
提示 `very-happy daemon start`。如 policy 显示 available/required，输出 server 目标的精确
npm 命令。不在 `--version`、MCP stdio、daemon log 或 agent TUI 中异步打印。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 daemon + 旧 server | GET 404/失败，不写 cliUpdate，其他能力正常 |
| 旧 daemon + 新 server | 不请求新端点 |
| 新 Web + 旧 daemon | 无 cliUpdate 则不显示通用 banner，功能级旧版提示保留 |
| 旧 Web + 新 daemon | zod/object 未知字段被忽略，无回归 |

发布顺序：server → CLI(tag) → Web → daemon 自动/手动交接。回滚时旧端均忽略新字段；
server registry 查询可以环境变量立即关闭。

## 风险

1. **npm 发布已完成但兼容性冒烟未完成**：Cloud 可用 `CLI_RECOMMENDED_VERSION`
   pin 已批准版本；registry discovery 只可显式启用，minimum 仍只能由 operator 明确设置。
2. **更新打断 direct PTY**：首版不代执行升级，文案不承诺零中断；现有 daemon
   交接机制不变。
3. **持久 banner 打扰**：全局 banner 仅消费在线机器；离线历史只在 diagnostics/machine
   detail 展示。available 按 machine+target dismiss；required 仅在 minimum 明确配置时出现。
4. **非法/恶意版本值**：server 与 daemon/Web 都严格 parse semver，命令只使用通过
   parse 的精确版本，不接受 server 传入 shell 片段。

## 验收标准

- [x] server resolver/route 覆盖 configured、registry、disabled、invalid、timeout/cache 与 minimum 边界。
- [x] daemon 首次 + 周期检查，结果同时进 local/encrypted state；旧 server 失败 fail-open。
- [x] CLI status/doctor 正确区分 installed/running/recommended/minimum，精确命令不含 latest。
- [x] Web available/required/current、多机器汇总、dismiss/new-target 重现有纯函数测试。
- [ ] banner 与 machine/diagnostics 均能到达精确升级指引，不与 PWA prompt 遮挡。
- [x] server / CLI / Web 完整门禁通过。

## 留真机验证项

- 桌面和移动 PWA 同时出现更新提示时不遮住终端输入/安装提示。
- 真实 `npm install -g <exact>` 后，现有 mtime 交接在 60s 内让 Web 消警且会话恢复符合预期。
