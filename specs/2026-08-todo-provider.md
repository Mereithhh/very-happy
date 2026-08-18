# 外部 Todo 面板（通用 provider）

> 状态：Draft
> 日期：2026-08-18 ｜ 关联 backlog：B-007 ｜ 出处：Owner 2026-08-17 对话，2026-08-18 派工
> 前身：B-007 原为「dida365 双向联动」，2026-08-17 改口径为只读直通 + 不落 server

## 背景

Owner 的待办分散在两处外部系统（滴答清单 = 个人 GTD 主库；Tanka follow-up = 公司 IM
内的跟进）。已有一个统一 todo MCP 让 claude 能查/建/改，但**人自己**要看要勾，仍然得
让 claude 代劳一次。诉求原话：「甚至在我们的 UI 上有对应的看板直接做操作，而不是每次
都让 claude code 手动操作」。

**本项目计划开源**，这条决定了设计的重量：very-happy 不能知道「滴答」或「Tanka」是
什么。它只知道「有一个用户配置的命令，按约定的契约吐 JSON」。Owner 的两个源是那个
契约的**一个实现**，不是产品的一部分。

## 目标

1. web 端有一个 Todo 面板：列出待办、勾完成、新建。
2. 数据不落 server：走 `machineRPC` 到 daemon，现拉现显。
3. very-happy 与具体 todo 服务**零耦合**：只认一条用户配置的命令 + 一份文档化的契约。
4. 仓库里带一个能跑的示例 provider，让人看得懂契约、且不接任何外部服务就能试。

## 非目标

- **不做双向同步、不做本地缓存**。面板是外部系统的一个视图，不是副本。
  （原 B-007 的「双向联动」已于 2026-08-17 否掉：`vh.board-tasks.v1` KV 是明文的，
  把个人 GTD + 公司 IM 待办同步进去等于把两类本该隔离的数据明文落 server；且同步的
  冲突/重复创建/tombstone 对齐不值得为「看板上勾一下」付。）
- 不与既有 Task Board（`vh.board-tasks.v1` / `boardTaskOps`）合并。那是 very-happy
  自己的会话任务，与外部 todo 是两种东西，混在一起两边语义都会坏。
- 不做编辑（改标题/截止/优先级）。**只做 list / complete / create** ——先验证形态。
- 不在 web 端配置 provider 命令（见风险 1，这是安全边界不是偷懒）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 机器级 RPC 的注册模式与作用域说明（我要照抄的参照物） | `packages/happy-cli/src/modules/fs/fsRpc.ts:1-18`，注册点 `src/api/apiMachine.ts:243` |
| `RpcHandlerManager` 把 handler 抛的错编码成 `{error}` **正常响应**（B-003 坑）——web 侧必须显式检查 `error` 字段 | `fsRpc.ts:12-17`、web 侧先例 `packages/happy-web-v2/src/sync/fsOps.ts:88` |
| web 调机器 RPC 的写法，含「冷启动 key 未同步」的守卫 | `packages/happy-web-v2/src/sync/fsOps.ts:80-92` |
| machineRPC 现在有 60s 超时（B-138），超时映射成 `timeout` 失败态 | `packages/happy-web-v2/src/sync/apiSocket.ts`、`sync/rpcTimeout.ts` |
| 机器本地设置的形状与「为什么机器本地」的先例（`boardLlm`） | `packages/happy-cli/src/persistence.ts:40-57` |
| daemon 本就暴露 `bash`，所以「跑一条用户配的命令」不是新增能力面 | `fsRpc.ts:10`（"single-user daemon that already exposes bash"） |
| 对外契约文档已存在且是英文，带 adapter 示例章节 | `docs/channels.md`（`## Adapter example`） |
| web 端「列表 + 操作」的面板先例（路由 + dock + 纯函数状态） | `packages/happy-web-v2/src/screens/notes/`，路由 `src/app/AppRoot.tsx:122` |

## 设计

### D1. Provider 契约（这是本 spec 的核心产物）

very-happy 调用一条用户配置的命令，形式固定：

```
<command> [args...] list
<command> [args...] complete <id>
<command> [args...] create <title>
```

- **stdout 必须是 JSON**，stderr 随意（失败时展示给用户）。
- **exit 0 = 成功，非 0 = 失败**。失败时 stderr 的末尾若干字符作为错误信息回给 web。
- `list` 的输出：
  ```jsonc
  { "items": [
      { "id": "abc",            // 必填，后续 complete 用它定位
        "title": "写周报",       // 必填
        "status": "open",       // 可选，'open' | 'done'，缺省 open
        "due": "2026-08-20",    // 可选，原样透传给 UI 显示
        "priority": "high",     // 可选，'none'|'low'|'medium'|'high'
        "group": "工作",         // 可选，UI 用来分组
        "note": "…" }           // 可选
  ] }
  ```
  只有 `id` 与 `title` 是必填；其余缺了就不显示。**未知字段一律忽略**（前向兼容）。
- `complete` / `create` 的输出**不解析**，只看退出码。理由：不同后端返回体千奇百怪，
  解析它等于把后端的形状焊进 very-happy；要确认结果就重新 `list`。

**为什么是 argv 子命令而不是 stdin JSON-RPC**：provider 大概率是个几十行的 shell/python
脚本，argv 子命令能用 `echo`/`jq` 手搓出来、能在终端里直接试；JSON-RPC 要写循环、
难调试。这是给人写的接口，不是给机器写的。

### D2. 配置：机器本地，且 web 不可写

`~/.happy/settings.json` 新增：

```jsonc
"todoProvider": {
  "command": "/abs/path/to/provider.mjs",  // 必填；绝对路径
  "args": ["--source", "dida"],            // 可选，固定前缀参数
  "cwd": "/some/dir",                      // 可选
  "timeoutMs": 20000                       // 可选，默认 20s
}
```

缺省（不配）= 功能整体关闭，web 面板显示「本机未配置 todo provider」+ 指向文档。

**必须机器本地、必须 web 不可写**——见风险 1。沿用 `boardLlm` 的先例（同一份 settings、
同样的理由：CLI 读不到 web 那份加密的 synced settings）。

### D3. daemon 侧：三个机器级 RPC

`todo-list` / `todo-complete` / `todo-create`，注册在 `apiMachine` 的
`RpcHandlerManager` 上，紧挨着 `registerFsHandlers`。

- 纯函数模块 `src/modules/todo/todoContract.ts`：解析并规范化 provider 的 `list` 输出
  （丢弃缺 id/title 的条目、规范化 status/priority、上限截断）。**不碰 I/O，可测。**
- `src/modules/todo/todoRpc.ts`：起子进程、超时、把失败编码成稳定的 code 字符串
  （`not-configured` / `spawn-failed` / `timeout` / `bad-output` / `provider-error`），
  照 fsRpc 的 B-003 约定（web 侧显式检查 `error`）。
- **全程 argv 列表 + env dict，绝不经 shell**。（skills repo 那个 todo MCP 2026-08-17
  实测过：把标题拼进 `bash -c` 时一个撇号就是语法错误，构造过的标题可执行任意命令。
  这里用户标题同样来自外部系统，同一个坑。）

### D4. web 侧：独立面板，不并进 Task Board

新增路由 `/todos` + 一个 `TodosScreen`，形态照 `screens/notes/` 的先例（列表 + 行内
操作），**不动 `/board`**（那是 very-happy 自己的会话任务，语义不同；且 board 是并行
工作的热区）。

- 机器选择：**spec 初稿写「默认当前上下文的机器」是错的** —— `/todos` 是全局路由，
  根本没有机器上下文。定稿：记住上次选的（device-local `todoMachineId`）→ 否则第一台
  在线机器；机器消失则回落。多机器时给选择器，单机器显示静态文本。
  **机器名常驻显示**（provider 是每台机器各配的，不显示就会张冠李戴——风险 5）。
- 拉取：进面板拉一次 + 手动刷新按钮。**不做轮询**（外部系统的速率限制不该由我们赌）。
- 勾完成：乐观置灰 → RPC → 成功后重新 `list`；失败则回滚并提示。
- 新建：一个输入框 → `create` → 重新 `list`。
- 六种失败态都要有明确文案，不能空白或一直转圈。其中 `not-configured` **不走错误框**
  ——它是「功能没开」不是故障，要给引导（怎么配 + 指向 docs/channels.md + 提一句仓库
  自带示例 provider），且不给 Retry 按钮。`provider-error` 必须**原样透出 provider 的
  stderr**：显示 "unknown error" 等于把人锁在门外。
- **刷新失败时清空列表**（实现时的取舍）：不留一份无法验证的陈旧列表假装是实时的——
  用户可能对着过期数据去勾，反而更糟。代价是一次瞬时超时会清屏，所以失败卡必须带 Retry。

### D5. 仓库里带一个示例 provider

`packages/happy-cli/examples/todo-provider-jsonfile.mjs` —— 用一个本地 JSON 文件当后端，
零依赖、零外部服务。作用有三：让人看懂契约、让人不接任何服务就能试通链路、给集成测试
当固定后端。

Owner 自己的 dida/tanka 源**不进本仓库**（它在私有 skills repo 里），只在
`docs/channels.md` 里作为「真实世界的一个例子」提一句形态。

## 兼容矩阵与发布顺序

| 端 | 影响 |
|---|---|
| 旧 web + 新 daemon | 旧 web 没有 `/todos`，不调新 RPC。无影响 |
| 新 web + 旧 daemon | 旧 daemon 未注册这三个方法 → server 回 `RPC method not available` → web 侧映射成 `unsupported`，面板显示「daemon 版本过旧」。**与 fs 浏览器当年同一条路径，文案照抄** |
| server | **零改动**（机器级 RPC 是既有通道） |

**发布顺序**：web 与 CLI 都可以先发，互不阻塞（新 web 遇旧 daemon 会友好降级）。
按默认序 web → CLI 即可；server 不动。

## 风险

1. **provider 命令 = 机器上的任意代码执行。** 所以它**只能从机器本地 settings 读，
   web 端绝不可写**——否则一个被劫持的 web 会话就等于 RCE。daemon 本就暴露 `bash`
   所以能力面没变，但「谁能设置它」是新的攻击面，必须钉死在本地。
   ⚠️ 实现时要有一条测试断言：web 传来的任何字段都不会影响 provider 的 command/args。
2. **provider 是外部系统的壳，会慢、会挂、会限流。** 缓解：默认 20s 超时、不轮询、
   失败有明确文案。⚠️ 别把它接进任何自动刷新的循环。
3. **标题来自外部系统，是不可信输入。** 缓解：全程 argv 不经 shell（D3）；web 侧
   按普通文本渲染，不解析 markdown/HTML。
4. **`complete` 的结果不解析** → 用户可能勾了但实际没成功。缓解：勾完强制重新 `list`，
   以外部系统的实际状态为准，而不是以我们的乐观更新为准。
5. **多机器时容易混淆**（每台机器 provider 不同）。缓解：面板显式显示当前机器名。
6. **契约定死后再改会破坏第三方 provider。** 缓解：`list` 的未知字段一律忽略（前向
   兼容）；新增字段只能是可选的；契约进 `docs/channels.md` 并标注版本。

## 验收标准

- [ ] 未配置 provider 时，面板显示明确提示 + 指向文档，不报错不空白。
- [ ] 配上仓库自带的示例 provider 后：列表能拉出来、能勾完成、能新建，三者都以
      重新 `list` 的结果为准。
- [ ] provider 退出码非 0 时，stderr 内容出现在界面上（不是 "unknown error"）。
- [ ] provider 卡住时按 `timeoutMs` 超时，界面显示超时而不是一直转圈。
- [ ] provider 输出非 JSON / 缺 `items` / 条目缺 `id` 时，不崩：坏条目被丢弃，
      其余正常显示。
- [ ] 纯函数契约解析的单元测试，覆盖上述所有畸形输入。
- [ ] **安全回归**：断言 web 传入的参数无法影响 provider 的 command/args/cwd；
      断言标题含 `'` 与 `;` 时不会被 shell 解释（argv 路径）。
- [ ] 新 web + 旧 daemon（未注册这三个 RPC）→ 显示「daemon 版本过旧」而非白屏。
- [ ] 门禁：cli（test + 运行冒烟）、web 三件套全绿。

## 留真机验证项

- 手机上面板的可点区域与勾选手感。
- 接上 Owner 真实的 dida/tanka provider 后，一次真实的「看一眼今天要做什么 → 勾掉一条」。
