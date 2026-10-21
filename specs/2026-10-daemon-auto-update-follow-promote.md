# daemon 自动升级：promote 后几分钟内跟上，机器页看得到（B-718）

状态：Final · 关联 backlog：B-718（含 Lead 追加的 QA2 O6：metadata 版本号停在注册时的值）

## 现状事实（10-21 核实，均为只读取证）

| # | 事实 | 证据 |
|---|---|---|
| ① | 机器级开关默认**开**：`cliAutoUpdate ?? 'idle'`，只有显式写 `off` 才关；三台 Owner 机器的 settings.json 都没写这个键 | `packages/happy-cli/src/daemon/run.ts`（`enabled:`）；dev-sg、mac-office、主力mac 三台的 `~/.happy/settings.json` |
| ② | relay 策略：`autoUpdatePolicy=latest`，`autoUpdateVersion=0.2.180`，`source=registry` | `curl https://veryhappy.dev/v1/version/cli` |
| ③ | daemon 检查策略的时机：启动时一次，之后**每小时**一次（`DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS = 60 min`）。docs/configuration.md 写的「每 6 小时」是旧口径，6 小时是 harness 版本检测的周期 | `update/cliUpdate.ts`、`daemon/agentVersions.ts` |
| ④ | 0.2.180：publish run 39609083643 的 promote job 在 13:45:12Z 完成 | `gh run view` |
| ⑤ | **主力mac 是自动升级的**：21:48:58 开始 installing，21:49:08 installed，21:50:01 交接，比 promote 晚 3 分 46 秒，正好赶上它每小时 :48 的检查。0.2.179 那次 promote 在 11:55，它 12:47:46 才装，晚了 52 分钟 | mac-main `~/.happy/logs/2026-10-21-12-48-57-pid-16768-daemon.log` |
| ⑥ | **dev-sg 和 mac-office 是发版流程手动升级的**，在它们的整点检查之前：dev-sg `sudo npm i -g` 加 `systemctl --user restart`（13:46:47Z），mac-office 用 `vh-update 0.2.180`（13:47:26Z） | Release2 会话记录、dev-sg journal、两台 daemon 日志里都没有 `installing` |
| ⑦ | dev-sg 即使轮到自动升级也装不上：全局目录 `/usr/lib/node_modules` 归 root，`installCliSafely` 会按 B-489 返回 `install_location_not_writable`，结果是 `manual_required`（按设计不用 sudo）。mac-office 是 `/opt/homebrew`，用户可写，能自动升级 | `ls -ld`、`update/npmInstall.ts` |
| ⑧ | 机器页现状：「自动更新」只显示一个状态句。看不到开关状态、目标版本和上次检查时间；没有「立即升级」入口（B-442 的请求 RPC 只挂在横幅上）。自动升级交接后新 daemon 只报 `current`，看不出刚刚自动升过级 | Owner Web 主力mac 机器页文本；`MachineScreen.tsx` |
| ⑨ | `metadata.happyCliVersion` 停在注册时的版本：`getOrCreateMachine` 保留已有行的 metadata，启动时的更新只改了能力位（QA2 O6：dev-sg 显示 0.2.134） | `daemon/run.ts` 的 `updateMachineMetadata` |

**卡点结论**：默认开关和策略都没问题。慢是因为每小时才检查一次，最坏要等约 60 分钟，再加上等到空闲的时间。看不到是因为机器页没展示这些状态。dev-sg 另有安装目录不可写的问题，属于部署形态，不在本 PR 改。

## 方案

### (b) 推送，不缩短轮询（取舍）
- 只缩短轮询到 30 分钟：平均延迟从约 30 分钟降到约 15 分钟，代价是所有 daemon 的请求量翻倍，而且还是看运气。
- **推送**：relay 本来就每 60 秒解析一次 npm `latest`（registry 缓存 60 秒），给它加一个 watcher，`autoUpdateVersion` 一变就向所有 machine-scoped socket 发 `cli-update-policy {autoUpdateVersion}`。daemon 收到后等 90–150 秒（避开 CloudFront 对 `/v1/version/cli` 的 `max-age=60` 缓存，同时把全 fleet 的 npm 安装错开），然后**重新 GET `/v1/version/cli`**，走原有的全部闸门。如果策略里还是旧版本，5 分钟后再补查一次。
- 推送只是提示，不是指令：载荷里的版本 daemon 只用来去重，不会拿去安装。安装目标仍然只来自 REST 策略，原有边界（只在空闲时、只装 promote 过的版本、每个版本只试一次、走 B-321 交接）都不变。
- watcher 只在 `CLI_AUTO_UPDATE_VERSION=latest` + `CLI_VERSION_REGISTRY_LOOKUP=true` + 没有 `CLI_RECOMMENDED_VERSION` hold 时运行。pin 或 off 只会随重新部署变化，部署后 daemon 会重连并在启动时重新读取。
- 每小时轮询保留，作为老 relay、daemon 离线或推送丢失时的兜底。
- 新增 `CLI_VERSION_REGISTRY_URL`（默认 npm）。用于私有镜像，也用于下面的本地 promote 演练。

### (c) 机器页
daemon 在 `cliUpdate` 里新增两个可选字段：
- `autoUpdateEnabled`：机器级开关的值。
- `lastInstall {from,to,at,source}`：由安装成功的那个 daemon 写到 `$HAPPY_HOME_DIR/cli-update-last.json`，交接后的新 daemon 读出来继续上报。

Web 在「自动更新」一行显示「开 / 关」，并新增以下几行：
- 版本：`当前 → 目标`，或「已是最新」
- 上次检查
- 上次更新：`from → to · 自动 / 手动请求 · 时间`
- 「立即更新到 X」：复用 B-442 的 `cli-update-request`，同样等到空闲才装。离线、正在安装、交接被挡住、老 daemon 都不显示这个入口。

### (a) 默认值
已经是开的（见 ①），不需要改。显式写 `cliAutoUpdate: "off"` 的机器仍然保持关闭，机器页会显示「关」。

### O6
daemon 每次启动（包括升级后的交接）都会在 `updateMachineMetadata` 里重写 `happyCliVersion` 和 `happyLibDir`，其他字段保持原值（比如用户改过的机器名）。

## 兼容矩阵

| relay \ daemon | 旧 daemon | 新 daemon |
|---|---|---|
| 旧 relay | 不变 | 收不到推送，按每小时轮询；机器页新行照常显示（数据来自 daemon） |
| 新 relay | 旧 daemon 忽略未知事件，按每小时轮询 | promote 后约 2–5 分钟开始安装 |

Web 对老 daemon 降级：开关显示为空，当前版本退回 metadata 里的值，不显示「立即更新」。

发布顺序：server/Web 和 CLI 谁先发都可以。

## 验收
- 单测：`policyAnnouncement`（延迟窗口、去重、补查、垃圾载荷、停止）、`lastInstall`、`updateController`（开关、记录、交接后读回、失败不记录）、`withRunningCliFacts`、server `cliPolicyAnnouncer`（启动时只建基线、registry unavailable 不算变化、只广播一次）、`followsPromotedLatest`、`eventRouter` 的 machines room、`CLI_VERSION_REGISTRY_URL`、Web `machineAutoUpdateSummary`。
- 本地演练：用假 registry 和隔离 prefix 装 0.2.900，promote 到 0.2.901，记录时间线（见 PR 正文）。
