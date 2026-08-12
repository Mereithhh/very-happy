# Backlog — 产品迭代项事实源

> 全部输入（实报 bug / 想法 / 评审发现 / 技术债）落这里，一项一行。
> **单写者纪律：只有主 agent（或 Owner 本人）改这个文件**——Owner 在对话里
> 说的需求，主 agent 当场记入（不靠记忆）；实现 agent 只读不写。
> 多会话并发时改前先 `git pull` / 看 `git status`，一行一项使冲突可解。
>
> 为什么是文件不是 GitHub Issues：状态变更与代码同 commit（任意历史点
> backlog 与代码一致）、agent 零网络零凭据即可读写、可 grep；单人私有 repo
> 下 Issues 的通知/协作红利全部落空——2026-08 实证：PROCESS.md 曾规定用
> Issues，结果零 issue 零 label，流程从未跑通。若未来上全自动派工流水线，
> 再考虑单向导出 Issues，事实源仍在此文件。
>
> 字段口径：类型 = bug / ux / feat / debt；状态 = todo / doing / done / dropped。
> done/dropped 项在批次沉淀时移入底部「近期完成」，攒多了直接删（历史在 git）。
> 真机验证项不进这里，进 `docs/verify-queue.md`。大改动的设计进 `specs/`。

## 活跃

| id | 标题 | 类型 | 来源 | 状态 | 备注 |
|---|---|---|---|---|---|
| B-001 | 「server 部署后必须 vh-update」根治——**根因改判**：不是重注册缺失（RpcHandlerManager.onSocketConnect 会重发 rpc-register，链路是通的），而是 apiMachine `reconnection:false`+自研 startSmartReconnect 在 server 容器重启的半开 socket 场景下自认为还连着→既不重连也不重注册。修法：应用层 register-ack 心跳，超时强制 disconnect+connect | bug | PROCESS.md §4 + 2026-08-13 工程走查改判 | todo | 根治后删 PROCESS.md §4 流程项 |
| B-002 | `[happy]` 下发的任务在 task board 标注来源（P3） | feat | specs/2026-08-tanka-channel.md | todo | |
| B-003 | RpcHandlerManager 把 handler 错误编码为 `{error}` 正常响应——多数 ops 封装当成功（假 ack 面） | bug | 车道退役批遗留观察 | todo | 已修 openTerminal/killTerminal 两处，其余 RPC 封装待收口 |
| B-004 | 终端会话标签（@vh_tags 走 daemon 链路） | feat | 置顶标签批遗留 | todo | RenameModal 已留位 |
| B-005 | 渲染层 ghostty-web spike 复查 | debt | 渲染调研定论 | todo | 触发条件：0.5.0 发版+IME issue 关闭+内存损坏关闭 |
| B-006 | 看板任务生命周期重构（哲学：以任务完成管理，不以 claude 状态管理） | feat | Owner 2026-08-13 | done | Shipped 2026-08-13，见 spec |
| B-007 | dida365（滴答清单）任务双向联动 | feat | Owner 2026-08-13 | todo | 等 Owner 的 dida365 skill/CLI 就绪；走 channels 适配器模式 |
| B-008 | 更好的通知系统（分级/聚合） | feat | Owner 2026-08-13 | todo | 与 B-006/B-007 一体规划 |
| B-009 | `--version` 不提前退出会继续 daemon 流程——worktree 冒烟劫持生产 daemon（2026-08-13 真实事故：daemon 从已删 worktree 跑→posix_spawnp failed） | bug | 事故复盘 | todo | 修 CLI 让 --version 立即退出；冒烟命令已在 CLAUDE.md 改为 HAPPY_HOME_DIR 隔离 |
| B-010 | 侧边栏双形态：列表/状态/归档三段 + 删搜索框 | ux | Owner 2026-08-13 | done | Shipped web 66546248 |
| B-011 | 陈旧 bundle 复活已删终端——自动重载已上线 | bug | 实报+日志实锤 | done | Shipped 15c64f3f；各设备需手动最后刷新一次以获得自愈能力 |
| B-012 | 终端里的 claude 也发「等待下一步指令」通知（daemon agentState 跳变→webhook；聊天会话有、终端没有的对齐） | feat | Owner 2026-08-13 | done | Shipped a44bf95c / cli v0.2.32 |
| B-013 | 终端会话支持快捷指令（promptPresets 经 bracketed paste 写入 PTY，不自动回车） | feat | Owner 2026-08-13 | done | Shipped a44bf95c；PC=header，移动=快捷键行 |
| B-014 | 聊天会话渲染体验：移动端排版走查 + 代码块/工具输出/整条消息一键复制 + 移动 diff 折行 | ux | Owner 2026-08-13 | done | Shipped a44bf95c |
| B-015 | iOS 橡皮筋回弹去除 | ux | Owner 2026-08-13 | done | Shipped ea080eec（顺带禁 PWA 下拉刷新） |
| B-016 | 日志无轮转（现场 746MB）+ debugLargeJson 缺 return 放大器 | bug | 工程走查#1 | done | Shipped a44bf95c；daemon 启动清扫 14d/200MB 双上限 |
| B-017 | web 回滚备份 webapp.prev cp 嵌套损坏 | bug | 工程走查#3 | done | Shipped a44bf95c；rollback-web 一键化仍待做（见 B-020） |
| B-018 | 站内通知中心 + 可配置提示音（WebAudio 合成 4 音色，分事件开关） | feat | Owner 2026-08-13（合并原 B-008） | done | Shipped；含首开水位线基线化防未读风暴；版权原因不内置真实歌曲，后续可加本地上传自定义音 |
| B-019 | server 部署链路：migration 只同步不执行（prod schema 已漂移，AccountUnlock/AccountCredential 靠 $queryRawUnsafe 手工建表）；镜像无 CI build，「零新依赖」枷锁源头 | debt | 工程走查#2 | todo | 先 migrate diff 对账再接 migrate deploy；解除后 server 依赖才能升级 |
| B-020 | deploy 工作流加 rollback-web target（一键回滚而非口头流程） | debt | 工程走查#3 | todo | |
| B-021 | daemon 无保活：uncaught → 退出即死，install.ts 的 launchd 代码零调用 | debt | 工程走查#4 | todo | 改用户级 LaunchAgent KeepAlive；退出原因经 webhook 推一条 |
| B-022 | 认证面加固：token 无 exp/吊销、trustProxy 未开（per-IP 限流退化成全局桶=自我 DoS）、/v1/auth/request 未认证无限写库、AuthRequest 表无 TTL | debt | 工程走查#5 | todo | 单用户私有部署，按序做：trustProxy→TTL 清扫→token epoch |
| B-023 | 测试盲区：终端 ingest/subscribeState seq-ring 记账（黑屏事故正主）与 settings LWW/pending 合并（铁律#1 事故机制）双双零覆盖 | debt | 工程走查#6#7 | todo | 抽纯函数补边界测试 |
| B-024 | Playwright 冒烟 E2E（登录→侧栏→开终端→回显断言），挂 deploy 后跑 | debt | 工程走查#8 | todo | |
| B-025 | server 数据保留策略（Session/消息/UsageReport 无定时清理；SimpleCache 无过期字段）+ DB 体积接告警 | debt | 工程走查#9 | todo | 先只报数跑一周再开删 |
| B-026 | webhook 出站零重试（Tanka 抖动=通知永久丢）+ 投递失败数进诊断页 | debt | 工程走查#10 | todo | 进程内 3 次指数退避 |
| B-027 | web 健壮性三件套：ErrorBoundary（现在渲染异常=白屏）、离线/重连横幅、store 消息 LRU 逐出 | debt | 工程走查#11+UX走查#13#14 | todo | ErrorBoundary 最便宜收益最大，优先 |
| B-028 | bundle 瘦身：514KB gzip 首屏、两套 crypto 打一个 chunk、shiki 全语言进 precache（每次发版 PWA 重下 5.7MB） | debt | 工程走查#12 | todo | shiki 动态 import + globIgnores |
| B-029 | 上游同步：加 upstream remote + UPSTREAM_SYNC.md（server/cli 仍可 cherry-pick，web 已另立） | debt | 工程走查#13 | todo | 季度扫一次 |
| B-030 | patches/*.cjs 静默失效风险：patched===0 时应 exit 1 或迁 pnpm patchedDependencies | debt | 工程走查#14 | todo | |
| B-031 | CI 加 gitleaks job；核 metrics 0.0.0.0:9090 是否公网可达；daemon 本地控制口无签名 | debt | 工程走查#15 | todo | |
| B-032 | 看板/侧栏卡片上直接批权限（Approve/Deny/Approve-for-session；sessionAllow/Deny 已是纯 ops） | ux | UX走查#1 | todo | 多会话并行的最高频点击链 |
| B-033 | agent 干活时可发排队消息（iOS 与 PC 行为还不一致：PC 回车能发、手机被 Abort 按钮挡住） | ux | UX走查#2 | todo | |
| B-034 | ExitPlanMode 计划 Markdown 渲染 + 行内批准按钮（现在是 JSON）；AskUserQuestion 选项可点选 | ux | UX走查#3#4 | todo | schema 都已在 knownTools |
| B-035 | @文件引用 + /斜杠命令补全接线（suggestionFile/suggestionCommands 已移植零 importer） | ux | UX走查#5 | todo | |
| B-036 | FilesPanel 看 diff（git diff via sessionBash + 复用 DiffView；现在只能看全文） | ux | UX走查#6 | todo | |
| B-037 | 终端 QoL：@xterm/addon-search（Ctrl+F 搜 scrollback）+ 字号可调（iOS 12px 偏小） | ux | UX走查#7#8 | todo | |
| B-038 | 会话内搜索 + transcript 导出；用户图片进 transcript、工具返回图片渲染 | ux | UX走查#9#10 | todo | |
| B-039 | ⌘K 增强（machines/看板/归档/主题/模糊匹配）+ ⌘1-9 上提 layout 层（现在侧栏折叠/移动端失效） | ux | UX走查#11#12 | todo | |
| B-040 | machine 离线 UX + CLI 版本过旧警告接线（isVersionSupported/dismissedCLIWarnings/文案全零调用） | ux | UX走查#17 | todo | 骨架全在只差接线 |
| B-041 | 死设置清理：diffStyle(split)/expandTodos/groupToolCalls 等 12 项无消费者——实现或删除 | ux | UX走查#18 | todo | |
| B-042 | worktree 会话 UI（NewSessionDraft 已有 sessionType 字段零 UI）+ 新建会话最近路径/目录补全 | ux | UX走查#19 | todo | 与 Owner 的 worktree 工作流直接相关 |
| B-043 | 看板过滤/批量操作（按机器/tag；多选；清空 ended）；移动端断点统一（860/980 夹缝）+ PWA manifest 解除 portrait 锁定 | ux | UX走查#16#20 | todo | |
| B-044 | 长会话性能：ChatList 虚拟化 + lineDiff LCS 无尺寸上限保护 | debt | UX走查#21 | todo | 触发条件：单会话 >2k 条实测卡 |
| B-045 | 快捷指令快捷键：⌘. 弹 presets 菜单（聊天+终端）+ 数字键直选 | ux | Owner 2026-08-13 | doing | 终端页需 capture 拦截防 xterm 吞键 |
| B-046 | 移动端会话详情页通知铃铛入口（现在只在根侧栏；详情页靠提示音） | ux | Owner 问题引出 2026-08-13 | todo | 等 Owner 真机用两天再定是否要 |
| B-047 | 文件浏览器：终端/聊天会话浏览 cwd 目录与文件内容（daemon 机器 RPC fs-list/fs-read + 终端抽屉 + FilesPanel 浏览模式） | feat | Owner 2026-08-13 | doing | 旧 daemon 降级提示；读上限 512KB |

## 近期完成

| id | 标题 | 类型 | 状态 | 备注 |
|---|---|---|---|---|
