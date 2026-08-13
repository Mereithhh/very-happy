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
| B-045 | 快捷指令快捷键：⌘./Ctrl+. 弹 presets 菜单（聊天+终端）+ 数字键直选 | ux | Owner 2026-08-13 | done | Shipped e81f25b2；Safari 的 ⌘. 是停止加载可能被截走（主力 Chrome/PWA 无碍） |
| B-048 | Web Push 通知栏修复：v2 generateSW 丢了 push/notificationclick 处理器（订阅成功但推送永不显示）+ 终端事件接设备推送（dispatchDeviceEventPush，在线抑制） | bug | Owner 问题引出 2026-08-13 | done | Shipped e81f25b2；deploy 顺带修 electron postinstall 头号 flaky |
| B-046 | 移动端会话详情页通知铃铛入口（现在只在根侧栏；详情页靠提示音） | ux | Owner 问题引出 2026-08-13 | todo | 等 Owner 真机用两天再定是否要 |
| B-047 | 文件浏览器：终端/聊天会话浏览 cwd 目录与文件内容（daemon 机器 RPC fs-list/fs-read + 终端抽屉 + FilesPanel 浏览模式） | feat | Owner 2026-08-13 | done | Shipped 02cb8543 / cli v0.2.33；spec Shipped |
| B-049 | 剪贴板体验重设计：默认静默复制+可点 toast 兜底（不再弹阻断 modal）+ 历史面板（50 条/32KB 护栏/编辑再复制/清空） | ux | Owner 2026-08-13 | done | Shipped；入口 ⌘K+设置 Channels；历史每设备本地不同步 |
| B-050 | 新 logo「会眨眼的终端窗口」+ 整套应用图标（gpt-image 探索方向 + Pillow 按 token 重建主源） | ux | Owner 2026-08-13 | done | Shipped；候选在 skills/tmp/vh-logo/；7 条设计感提案待 Owner 挑 |
| B-052 | 统一快捷指令：promptPresets 加 run 标记吸收 terminalCommands（一次性幂等迁移+菜单合并，同一份文本聊天/终端通用） | ux | Owner 2026-08-14 | done | 迁移保持插入语义不自动执行；run 为 opt-in；terminalCommands 保留兼容无 UI 入口 |
| B-070 | 侧栏「最近活跃」自动排序（终端+聊天混排；与手动排序做无损模式切换，拖拽即切手动） | ux | Owner 2026-08-14 | done | activityAt 链路本就通、无需动 daemon；纯输出上浮最多滞后 60s（签名量化）；状态视图维持看板序；**原记为 B-053，与另一会话撞号后改号** |
| B-071 | 全局返回：统一四套返回箭头为 useAppBack（真实历史优先+层级父级回退）+ ⌘[/Alt+← + 移动端左边缘滑动返回 | ux | Owner 2026-08-14 | done | Shipped；桌面也显示返回键（全局的直接后果）；/assistant 的形态切换箭头刻意保留；**原记为 B-054，撞号后改号** |
| B-065 | 侧栏铃铛移到底部与设置同排（header 太挤） | ux | Owner 2026-08-14 | done | 折叠 rail 的铃铛也 pin 到底部，避免收起/展开时上下跳 |
| B-066 | 通知已读跨设备同步：看过对应会话即自动消除该目标的通知（按 key 取 max 时间戳合并，非整表覆盖） | feat | Owner 2026-08-14 | done | 载体=账号 KV vh.notif-seen.v1（CAS+absorb 重试）；顺带接上从未被监听的 kv-batch-update 广播=跨设备 push 而非轮询 |
| B-087 | 文件预览升级：markdown 渲染/源码切换 + 图片缩放（Blob URL，弃 data URI）+ PDF 原生 viewer + 全屏 + 滚动修复（根因=聊天转录的 420px overflow:hidden 被查看器误继承）+ fs-read offset 分段（socket 载荷 1MB 钉死单窗，10MB 护栏） | feat | Owner 实报 2026-08-14 | done | edf24288；对照 apodexchat 抄判定/Blob/护栏，弃 pdf.js（531KB 只益移动端，iOS PDF 表现待真机，刚需再评估）；真机 V-038 |
| B-088 | 文件浏览器布局：两宿主共享拖宽（filesPanelWidth 280px~60vw）+ 终端抽屉 overlay 改分栏挤压（反转旧「不做 inline sidebar」决定；拖拽期 fit 抑制防 reflow 风暴；移动端 display:contents 原形态零回归） | ux | Owner 实报 2026-08-14 | done | 6b11cc44；FitAddon 走既有 RO→scheduleFit 实战链路；真机 V-039 |
| B-089 | ⌘W 语义纠正：收掉会话而非关视图（聊天=归档确认 kill-first、终端=关闭确认先导航防复活；closeViewConfirm 改写=关则直接执行；非会话路由不拦交还浏览器） | ux | Owner 实报 2026-08-14 | done | b7d765ef |
| B-090 | 命令面板「归档当前会话」只调 sessionArchive 不走 kill-first——与 rowActions 语义不一致（活着的 CLI 会把 active 翻回来复活） | bug | B-089 实现中发现 | todo | 改调 confirmArchiveSession 或 archiveSessionNow 对齐 |
| B-091 | 侧栏按 tag 分组视图 + assistant 派发 session 自动打 tag 分开展示 + 排查 meta 会话泄漏（嫌疑：B-053 过滤加在旧列表构建器，新侧栏 rows 走 useSessions 直建未过滤）+ 轻量「优先」标记加权置顶（四象限视图暂缓，机制先行——Owner 用两天再定） | feat | Owner 实报 2026-08-14 | doing | |
| B-092 | 语音助手 UX 两件：toolcall 展示友好化（图标+友好名+参数摘要，非裸 mono 行）+ 按住说话开始的明确反馈（提示音 earcon + Android 震动 + 视觉强化——iOS 不支持 vibrate 如实降级） | ux | Owner 实报 2026-08-14 | doing | |
| B-067 | 活跃排序实时化：daemon 轻量 ephemeral 活跃通道（不落库）+ 本机交互即时打点；60s 桶保留给落库路径 | feat | Owner 2026-08-14 | done | 本机 120ms / 远端典型 0.5-0.6s 最坏 2.1s；冷终端（pty 已回收）仍 ~10s；需 CLI ≥v0.2.37 |
| B-068 | 潜伏 bug：`boardTasks.initialize()` 依赖 `getCurrentAuth()` 在 AppLayout 挂载时已就绪，但它由 AuthProvider 的 effect 发布（子 effect 先于父 effect）——目前靠「用户总是先导航再进 /board」侥幸避开，**直接落地 /board 会静默不初始化** | bug | B-066 实现中发现 | todo | 修法：同 useSeenTracker，从 context 取 credentials 再交给 store |
| B-069b | 冷终端（pty 已回收、无人看）活跃上浮仍受 10s tmux tick 约束——「没人看的 agent 又开始跑了」是最扎的场景 | debt | B-067 残留 | todo | 修法=提高 tmux 轮询频率（subprocess×终端数），当前判定不值得 |
| B-072 | 侧栏选中态视觉加强（accent 竖条+背景抬升+文字提亮，亮暗双主题） | ux | Owner 2026-08-14 | done | **真因**：hover 规则写在选中之后且未排除选中行→划过当前行时选中背景被改写；顺带补触摸按压回馈 |
| B-073 | ⌘W 关闭前二次确认（应用内确认 + 普通标签页的 beforeunload 保护；两个开关默认开） | ux | Owner 2026-08-14 | done | 顺带修 modal 两处真缺陷：点遮罩不 resolve（await 永久挂起）、缺键盘处理；看板「标记完成」补 destructive 防误敲回车批量归档 |
| B-074 | `ui.css` 的 `.vh-item.is-selected` 仍是老写法（bg-2+3px），且 `Item` 的 `selected` prop 零调用方=死参数——实现或删除 | debt | B-072 发现 | todo | |
| B-051 | 语音助手第二形态（类 Siri）：logo 动效 + 按住说话（ElevenLabs STT/TTS）+ meta-agent 调度中心（经 very-happy MCP 操作/新建 session、读终端、派任务）+ compact + 记忆系统（个人记忆↔agent-system context，grep 检索）+ 音色设置 + 两形态一键切换；移动端体验优先，现有形态零回归 | feat | Owner 2026-08-13 | doing | spec Final + 三包实现合并 + 本地 E2E 走查 + 回扫修复完成；待发布与真机验收（V-022~026） |
| B-064 | web-v2 缺 terminal-connect 批准 UI：CLI `auth login` 指向 `/terminal/connect#key=…` 无路由，authApprove.ts 零调用——新机器接入官方路径存疑 | bug | B-051 E2E 走查#4 | todo | 影响新机器 onboarding；本批用脚本代跳过 |
| B-069 | 语音助手 Phase 2（Owner 已拍板 2026-08-14）：**做** ①双向流式 TTS（stream-input WS + single-use token 浏览器直连，HTTP 代理兜底）②双向流式 ASR（scribe_v2_realtime WS，manual commit=PTT 形状，实时字幕，batch 兜底）+ ASR 识别语言设置（中文准确率根因=从没传 languageCode）⑤主动汇报（session onTurnEnd→daemon /session-event→assistant 开口）⑥PC 文字记录右侧常驻栏；**搁置** ④earcon ⑦PWA shortcut ⑧转写可编辑 | feat | Owner 2026-08-14 | done | spec Shipped；server+web 已上线（Actions 配额耗尽走本地 deploy.sh）；daemon 0.2.38 本地 tarball 直装；**npm v0.2.38 待配额恢复后 rerun publish（tag 已推）**；真机 V-032~034 |
| B-075 | GitHub Actions 私有仓配额耗尽——CI 会话迁 fb-us self-hosted runner 解除；v0.2.38 重指 tag 后经新 runner 发包成功（npm 实证） | debt | 发布事故 2026-08-14 | done | 残留：托管 macOS/Win 冒烟仍被计费闸门拦（等账号侧处理）；linux node24 Install pnpm 挂（CI 会话跟进） |
| B-078 | CI 迁 self-hosted 落地：fb-us CT110（4核/8G/60G，内网 100.100.3.31）3 个 runner 实例；quality 5 job 合 1；cli-smoke 跨平台矩阵只在 tag；runner-probe 健康探针 | debt | B-075 根治 | done | 容器需自装 build-essential（node-pty 编译）；Node 大版本要预铺 tool cache；每实例独立 pnpm store（**只认 npm_config_store_dir**） |
| B-079 | pnpm/action-setup 的 dest 按 job 隔离——3 个 runner 实例共享同一 HOME，默认的 `~/setup-pnpm` 被并发 job 互删（v0.2.38 发版实锤：node20 格过、node24 格挂 `ENOENT: process.cwd failed`） | bug | 发版实锤 2026-08-14 | done | 改成 job 级 `runner.temp/setup-pnpm`；4 个 workflow 全改。**根因不是 node24 兼容性** |
| B-080 | 长期盲区已照出：happy-server 测试此前只在 macOS 跑过、生产在 Linux——迁 CI 后首次 Linux 运行即暴露 voiceRoutes S1 挂死（fastify 测试 app 需 forceCloseConnections） | debt | CI 迁移副产物 | done | 规则：server 侧真 socket/进程/fs 语义的测试以 Linux 为准 |
| B-076 | 侧栏「最近活跃」自动排序 disable（Owner 实报：tab1/tab2 随活跃互换位置，⌘数字快捷键不稳定——自动排序与位置型快捷键原则冲突）：resolveSidebarSort 恒 manual + 隐藏切换按钮；机制保留（B-070/067 的实现与设置字段都在），要恢复翻一个 flag | ux | Owner 实报 2026-08-14 | done | 固定序=手动拖拽记录，无记录的新行按创建时间新在上 |
| B-077 | 通知浮层出屏（B-065 铃铛移底部的遗留：浮层仍向下弹）——下半屏锚点自动向上翻（data-up + --nc-bottom，max-height 同步换算） | bug | Owner 实报 2026-08-14 | done | |
| B-081 | 中文音色：Settings→Voice 内置 ElevenLabs Voice Library 浏览（默认中文筛选）+ 试听 + 一键添加到账号（自动选中）；server 代理 shared-voices 搜索与 add 端点 | feat | Owner 2026-08-14 | doing | 任何音色本可说中文（flash 多语言），本项解决「地道中文嗓音」；原登记 B-078 撞号改号 |
| B-082 | 机器设置入口：Settings→机器 列表页（在线状态+点击进 /machine/:id 改名/开会话）——机器详情页与 displayName 改名功能一直存在但全库零导航入口（孤岛页）；appBack 映射同步修正 | ux | Owner 2026-08-14 | done | 改名写 metadata.displayName 全端同步（机制原有） |
| B-083 | 去「删除」概念：全系统只有归档（聊天会话删除入口移除，归档=唯一收尾且全记录留存；终端「删除」改「关闭」中性文案——claude 对话在 ~/.claude JSONL 可 --resume）| feat | Owner 2026-08-14 | done | **审计结论：原「删除」是彻底硬删（消息/用量/Session 行全清，无审计痕迹）**，归档才全留——本项使「记录永在」成立；spec Shipped；server DELETE 端点保留给 B-025 |
| B-084 | 「已结束终端」可见记录：daemon 双路径捕获（主动关闭+tick 消失 diff）20 条入 daemonState.closedTerminals + 归档视图分组 + 在同目录开新终端 | feat | B-083 spec 遗留 | done | a031d968；真机 V-035 |
| B-085 | 侧栏「待处理」行醒目化：两级标识——等你处理（permission/needsInput/review/blocked，复用 board 分类）=accent 左边条+标题加权+光晕点+pulse；普通未读=text 级点（不染 teal 防信号淹没）；v2 此前 unreadSessionIds 零消费 | ux | Owner 实报 2026-08-14 | done | 2535dd58；选中 rail 由 accent 改 ink 让位（accent=live 纪律更纯了）；真机 V-036 |
| B-086 | 通知自动已读后未读角标不减 | bug | Owner 实报 2026-08-14 | done | **根因改判：计数与条目从未分叉，洞在 seen 写入侧**——「看着跑完再关掉/切走」不打 stamp（hidden/pagehide/自视图到达三个洞全补，生产实测 3652ms 原型进回归）；存量卡死条目重开会话 1 秒即清 |
| B-053 | assistant 会话在侧栏/board 特判：meta 会话不进普通列表（Owner 确认设计：基础设施层=普通会话，呈现层隔离；/session/<id> 仍可审计） | ux | B-051 E2E 走查#7 + Owner 2026-08-13 | done | buildSessionListViewData + boardItems 双过滤 |
| B-062 | assistant 交互协议三件套：`<options>` 块→可点选项按钮（不朗读，答完即收）+ 任务盘点把活终端一并当任务报（CLAUDE.md 口径）+ 文字记录思考轨迹/工具输入可折叠展开 | feat | Owner 实报 2026-08-13 | done | 模板与本机 CLAUDE.md 均已更新 |
| B-063 | 调度器工具纪律做实（Owner：meta 会话工作方式/工具面应不同于普通会话）：assistant 变体 SDK 级硬禁 Bash/Edit/Write/MultiEdit/NotebookEdit（per-message 覆盖只能加严不能解禁）+ 新 MCP 工具 journal_append 作为日志写入正道 + CLAUDE.md 工具边界声明 | feat | Owner 2026-08-13 | done | OpenClaw 调度器纪律；保留 Read/Grep/Glob/web/Task |
| B-054 | assistant 版本门控 dev 逃生门：dev 构建恒 0.1.0 被 ≥0.2.34 挡住，本地联调要 hack machine metadata | debt | B-051 E2E 走查#3 | todo | dev override（env/localStorage）或特判 0.1.0 |
| B-055 | 复核 assistant 会话 dangerouslySkipPermissions=true 的来源 | debt | B-051 E2E 走查#8 | done | 根因=fork 全局默认 permission mode 就是 yolo（runClaude.ts:55），非 assistant 特有；已做成可关设置（B-061） |
| B-056 | /board 在 devtools emulate 切换后首进偶发主线程阻塞 >40s（一次复现，二次不可）| bug | B-051 E2E 走查#5 | todo | 低置信度观察项，遇到再深挖 |
| B-057 | B-051 回扫 cleanup 遗留：版本比较器与既有 semver 工具重复、tmux format 字符串复制+ptyEnv 缺漏、web recorderState 死代码、session_archive 手搓 REST（有现成封装）、TTS 2000 上限 web/server 两处硬编码应进 happy-wire | debt | code-review 回扫 | todo | 一批小清理，攒着下批做 |
| B-058 | 「启动语音」点击后整页卡死 | bug | Owner 实报 2026-08-13 | done | 根因=keep-alive 1 采样点静音 WAV loop 打爆媒体栈；改运行时生成 1s 静音 blob，带回归测试；58eba02a |
| B-059 | 语音字幕 + 文字记录：TTS 播报实时字幕（当前朗读句大字幕）+ 界面内置文字记录面板（不跳走）；ASR 字幕=转写即上屏（原有） | feat | Owner 2026-08-13 | done | 58eba02a |
| B-060 | assistant 动效升级 +「启动语音」文案说明（浏览器出声解锁） | ux | Owner 2026-08-13 | done | 58eba02a；「更炫酷」程度待 Owner 真机看，不够再加码 |
| B-061 | assistant 权限审批设置：默认跳过（现状=fork 全局 yolo 默认，B-055 根因即此），可关闭改人工 approve（spawn permissionMode 透传 + Voice 设置开关 + 等审批提示条） | feat | Owner 2026-08-13 | done | 5c713fe2；B-055 一并收口 |

## 近期完成

| id | 标题 | 类型 | 状态 | 备注 |
|---|---|---|---|---|
