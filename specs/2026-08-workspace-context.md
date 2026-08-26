# 工作区分组与可直达代码上下文

> 状态：Final
> 日期：2026-08-26 ｜ 关联 backlog：B-208 ｜ 出处/前身：Paseo 产品/源码只读研究

## 背景

当前侧栏的一级对象是单个聊天或终端。同一项目下同时存在 Claude 结构化会话、普通聊天和 tmux 终端时，用户需要靠标题记忆它们的归属；Changes / Files / Browse 虽已实现，却只是一块由组件本地布尔值控制的附属面板，不能直达、分享或用浏览器返回关闭。

Paseo 的 workspace-first 信息架构验证了“先定位项目，再看 agent 与代码上下文”的价值。本实现只借鉴产品模型；不复制其 AGPL 源码，也不迁移到 Expo/Electron/local-first 架构。

## 目标

- 列表视图可在平铺、工作区分组、tag 分组三种镜头间切换。
- 工作区身份严格由标准化后的 `machineId + cwd/path` 派生，终端与结构化会话可以归入同一组。
- 工作区标题可直接打开该项目代表性结构化会话的 Changes 面板。
- `?panel=changes|files|browse` 成为上下文面板的 URL 状态；切 tab 更新 URL，浏览器返回可以关闭/恢复面板。
- 沿用现有桌面右栏与移动端全屏覆盖形态，不增加移动端常驻栏。

## 非目标

- 不新增 Workspace 数据表、RPC、wire 字段或服务端持久化。
- 不改变会话创建流程、Git 数据源、文件 RPC 或终端渲染。
- 不在本批实现 turn outline、review queue、跨 workspace board 或 pane keep-alive。
- 不部署生产；完成后先交付本地质量门禁与浏览器验收结果。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 侧栏 row 已同时承载结构化 session 与 terminal，但只按生命周期或首 tag 分组 | `packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:58`、`:378`、`:663` |
| session 元数据已有 `machineId`、`path`、`host`；terminal 已有 `machineId`、`machineName`、`cwd` | `packages/happy-web-v2/src/sync/storageTypes.ts`、`packages/happy-web-v2/src/sync/terminalPushOps.ts:40` |
| FilesPanel 已有 Changes、Files、Browse 三个 tab | `packages/happy-web-v2/src/screens/session/FilesPanel.tsx:1`、`:109` |
| 面板开关目前是 SessionDetailScreen 内部 `useState(false)`，URL 不可表达 | `packages/happy-web-v2/src/screens/session/SessionDetailScreen.tsx:20`、`:81` |
| Git/file cache 已使用 `machineId:path` 作为项目作用域，派生 workspace 与既有数据边界一致 | `packages/happy-web-v2/src/sync/gitStatusSync.ts`、`packages/happy-web-v2/src/sync/projectFiles.ts` |

## 设计

### 1. 纯派生 workspace

新增纯函数模块接收已经排序好的 sidebar rows。对路径统一斜杠、去除非根路径尾部分隔符；key 为机器 id 与标准化路径的无歧义组合。缺少 cwd/path 的 row 按机器进入“未指定目录”，不能与其他机器混合。

组与组内 row 都保留输入首次出现顺序，因此不会破坏现有手动顺序。组名取路径 basename；同名项目通过机器名与紧凑路径副标题消歧。代表性 session 取组内第一个具备同一 workspace 元数据的结构化会话；纯终端组不伪造 Changes 入口。

### 2. 分组镜头

列表 header 用一个菜单选择“工作区 / 标签 / 不分组”，替代单一 tag toggle，避免移动端继续堆图标。设备本地新增 `sidebarGroupMode` 枚举；旧 `sidebarGroupByTag=true` 在读取 UI 状态时映射为 tag，新菜单选择 tag 时继续镜像该旧布尔值，保证回滚旧 Web 后仍保留 tag 选择。默认工作区分组，以直接改善主流程；状态与归档视图不受影响。

分组时继续禁用位置拖拽；用户切回不分组后原有手动顺序原样恢复。

### 3. URL 驱动上下文面板

SessionDetailScreen 将 `panel` query 参数作为唯一打开状态：

- `changes` → Changed files
- `files` → Project files
- `browse` → Machine browser
- 缺失或非法值 → 面板关闭

header 打开时 push `panel=changes`；关闭按钮和遮罩移除参数；tab 切换 replace 当前参数，避免每次 tab 点击污染返回栈。直接访问带参数 URL 与浏览器 Back 都得到同一渲染。

FilesPanel 增加受控 `tab/onTabChange`，保留旧的非受控调用兼容。明确指定 Changes 时即使为空也显示空态，不再悄悄跳到 Files。

### 4. 响应式与视觉

桌面沿用可拖宽的右栏；≤860px 沿用现有全屏 overlay。工作区 header 使用现有 bg/line/text token，accent 只留给活跃状态；Changes 按钮满足粗指针 44px 点击目标并带可访问名称。

## 兼容矩阵与发布顺序

纯 Web 改动，无协议与数据迁移。旧 Web 忽略新增 local setting；新版对旧 `sidebarGroupByTag` 做读取兼容。回滚 Web 后旧 tag 开关仍可工作；新增枚举只是设备本地冗余字段。

## 风险

1. **路径同名或跨平台格式不同**：key 使用 machineId + 完整标准化路径；标题副文案负责消歧，并补 Windows/POSIX 单测。
2. **terminal cwd 缺失**：按机器进入未指定目录，不错误并组；不展示无数据支撑的 Changes 入口。
3. **默认分组改变老用户视觉**：只影响列表镜头，排序数据不改；菜单可一键切回平铺。
4. **URL 与组件本地 tab 双状态漂移**：会话页只使用受控模式，query 为唯一事实源。

## 验收标准

- [ ] 同机器同路径的聊天与终端进入同一 workspace；不同机器/路径不误并。
- [ ] 平铺 / workspace / tag 切换不改写原有 row 顺序。
- [ ] workspace Changes 入口可用；纯终端/未知目录组不提供伪入口。
- [ ] 直接访问三个 panel URL、切 tab、关闭、浏览器 Back 行为一致。
- [ ] 桌面右栏与 390px 移动端全屏无横向溢出、遮挡或不可点目标。
- [ ] Web vitest、Vite build、tsc 全绿。

## 留真机验证项

移动端 Safari/PWA 的全屏上下文切换、系统返回手势与触摸观感在发布后登记并验收。
