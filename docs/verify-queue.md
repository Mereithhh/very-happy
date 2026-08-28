# 真机验证队列（verify queue）

> 自动化验不了的验收项（真机 IME / 触屏手势 / 视觉观感 / 需要 OS 原生
> 文件框、麦克风、系统权限弹窗的流程）在**每批发布时登记到这里**，
> 由 Owner 真机清账；**下一批开始前先清账，不许无限堆积**（PROCESS.md §5）。
>
> 登记人 = 发布该批的主 agent；清账 = Owner 验过后把结果写进「结果」列并
> 移入底部「已清账」。验证不通过 → 当场转 `docs/backlog.md` 建 bug 项。
> 浏览器验证注意 SW 缓存混版：硬刷新 / unregister 后再判断「没生效」。

## 待验证

| id | 版本/批次 | 验证项 | 怎么验 | 登记日期 |
|---|---|---|---|---|
| V-103 | B-255/B-256：Web `main@c1ffe04ab` 已发布 | **iOS/Android Web 英文键盘、长按退格与系统键盘互切** | 在真实 tmux 终端先展开系统键盘，再点快捷栏 `WEB`：系统键盘应收起、内置键盘出现，终端不得发生二次弹键盘或视口跳动；依次输入小写、Shift 单次大写、Shift 锁定、数字/符号、Space、Backspace、内置 Enter，PTY 收到内容应逐字一致。在英文字母页和符号页各长按退格约 2 秒，应先立即删一个字符，再稳定连续删除；松开、按住后滑出按键、系统切后台后都必须立刻停止，不能“卡住连删”。本体四个方向键应分别在 shell 历史/TUI 中正确移动，不能因上方快捷栏横向滚动而缺键。快捷栏独立 Enter 应能确认 TUI 提示；Ctrl→Web 字母仍应发送控制码。Web 模式下点终端画布不得在背后唤起系统键盘；点系统键盘图标应直接切回系统输入，点 `WEB` 自身应只收起内置键盘。再切一次输入行模式和选择/复制模式，三种输入面不得重叠。iPhone Safari/PWA 与 Android Chrome 各做一次竖屏，Home Indicator、安全区、横向溢出与末行可见性正常。自动化覆盖完整 ASCII、控制/方向字节、连删节奏和 Chromium 窄屏布局；真实 OS 触摸/软键盘生命周期只能真机清账。 | 2026-08-28 |
| V-102 | B-247：Claude SDK 会话 loading 居中（Web `main@a2d0bdd2` 已发布） | **冷会话 / 慢网下 loading 首帧位置稳定** | 发布后打开 DevTools Network，勾选 Disable cache 并限速 Slow 3G，从侧栏进入一个普通 Claude SDK 会话；OrbitLoader 应从出现的第一帧就在 header 与底部状态区之间居中，直到消息出现都不得先在顶部闪一下或二次跳位。桌面展开/收起侧栏各一次，手机竖屏再一次；自动化已锁定 loading DOM 的 `.cl-scroll` 居中规则，但不能替代逐帧观感验收。 | 2026-08-28 |
| V-101 | B-244：Claude Queue/Steer + plan approval（Web `main@a2d0bdd2` + CLI `v0.2.87` 已发布） | **真实 Claude SDK ExitPlanMode 审批后继续同一轮** | 新开 Claude session，分别在 default 与 yolo mode 让 Claude 进入 plan mode 并调用 `ExitPlanMode`；点击批准后，审批卡应结束 loading，Claude 应在同一 session 继续执行计划，不能只展示 `ExitPlanMode` tool call 后停住。拒绝仍应停在计划阶段，且不得误切 mode。自动化已覆盖批准不再在 `canUseTool` 回调内发嵌套 permission-mode control request。 | 2026-08-28 |
| V-100 | B-244：Claude Queue/Steer + plan approval（Web `main@a2d0bdd2` + CLI `v0.2.87` 已发布） | **桌面/手机真实 Queue、Steer 与 Stop 语义** | 更新 daemon 后新开 Claude session，让当前 turn 执行长任务：普通发送应进入 composer 上方可编辑 queue，当前 turn 不被打断；点某条“调整当前方向”后，该输入应进入当前 SDK turn 并改变后续方向，不出现 `[Request interrupted by user]`、`[ede_diagnostic]` 或额外空消息；Stop 才真正中止。再让 queued item 自然等到上一 turn 结束后自动发送。桌面与 390/320px、中文 IME 下按钮无裁切，旧 daemon 不声明 capability 时不得展示 Steer。 | 2026-08-28 |
| V-099 | B-241：server/Web `1024073e4` + CLI `v0.2.84`（已发布） | **手机任意文件 picker、拖放与 50 MB 边界** | iOS/Android 各新开一个 Claude 普通 session：从系统文件 picker 选择 `.zip`、无 MIME/未知扩展名文件和图片，均应显示文件 chip/图片预览并可发送；再用可拖放设备把同类文件拖进 composer，页面不得导航离开。发送后让 agent 报出收到的 machine-local 路径并读取文件校验内容；50 MiB 原文件应可上传，50 MiB + 1 byte 应在选择阶段显示明确限制。升级前的旧 daemon 应只开放其明确声明的图片/PDF，不得让其他文件静默消失。重点观察手机后台切换、上传 loading、失败后草稿/附件是否可恢复；自动化已覆盖 arbitrary bytes、路径穿越、0600 权限、SDK additional directory、50 MiB+40 bytes server 边界及三包全门禁。 | 2026-08-27 |
| V-098 | B-240：durable queue cancellation（待发布 Web+CLI） | **桌面/手机真实取消已投递消息** | 更新 CLI/daemon 后新开 Claude session，让当前 turn 跑一个长 Bash，再连续发送带 PDF 的追问并确认它进入 transcript 上方 durable queue：卡片应是紧凑 Console command buffer、长文最多两行、删除按钮无需 hover；点击后该行按钮立即 loading，文本和附件随后一起消失，当前 Bash 不被 abort，turn 结束后被删 prompt 不得执行。刷新及另一设备打开同 session 仍不得复活。再制造消息已被 SDK 取走的竞态：应 toast“已经开始”，原消息保留。桌面亮/暗主题及 390/320px 无横向溢出；composer 本地 queue 的编辑/删除/立即干预三键也始终可见。自动化已覆盖 source-id/legacy fallback、RPC too-late、墓碑两种分页顺序、附件 local id、i18n/loading wiring 与 Web/CLI 全门禁。 | 2026-08-27 |
| V-097 | B-234：queued message controls（由 B-244 / V-100 取代） | **iOS/Android 排队消息全交互** | 原“立即干预会停止当前 turn”的验收口径已被 B-244 废止，不再单独清账；队列编辑/删除/自然发送与新的 Steer（调整方向、不终止当前 turn）统一按 V-100 验收。 | 2026-08-27 |
| V-096 | B-233：Web + CLI 待发布 | **Beibin DSW terminal 与多端 Chat 状态** | DSW 机器更新 CLI 后从 Web 新建 terminal：即使 daemon 继承的 `SHELL` 指向宿主机不存在路径，也应创建可交互 shell 且 tmux pane 不秒退。再在 Claude chat 确认 `/goal` 等 skills/macros 出现在输入建议；会话 A 输入未发送草稿后切 B，B 不得出现 A 内容，切回 A 草稿仍在；手机把 mode 改为 yolo 并发送一条消息，电脑收到后 selector 应显示 yolo，随后加载更旧历史不得倒退到 default。自动化已覆盖 shell 可执行降级与 tmux argv、command 合并标准化、sub-debounce 草稿 flush、最新 user-meta/旧历史/assistant-only mode 决策；真实 DSW 镜像与跨设备手感需用户环境清账。 | 2026-08-27 |
| V-095 | B-230：Web+CLI 待发布 | **Claude SDK 结构化交互真链路** | 发布顺序 Web→CLI 后，用真实 MCP server 各触发一次 form elicitation（含 enum、number、boolean、string[]）和 URL elicitation：Web 卡片能填写/打开 http(s) 链接，批准后 Claude 收到精确 content，拒绝/abort 不留转圈 request；再真实触发一次 `refusal_fallback_prompt`，批准应选择 fallback 重试、拒绝应取消。最后制造一次 SDK error result，聊天中应显示错误文本，且不得出现 completed/done 通知。自动化已覆盖 agent-state/RPC 往返、choice token、failed turn、abort 清理和三包门禁；实际 MCP/拒答触发与 iPhone PWA 外链返回手感需真机清账。 | 2026-08-27 |
| V-094 | B-223~226：Web 待发布 | **iPhone PWA 更新、toast、token meter 与连续追问** | 用仍运行上一版的 iPhone 主屏幕 PWA 覆盖一次真实 Web 发版：①保持 app 打开或从后台恢复，新 worker 激活后应自行刷新并进入主页，不再长期停在 loading，也不需杀 app；②断网冷启动仍应按现有离线能力进入，版本检查不得额外卡住；③深色主题复制任意内容，toast 文字清晰、位于顶部安全区、约 2 秒消失且不挡 composer；④普通 Claude 对话完成一轮 usage 后，右下角显示进度条和“已用 / 总量”，1M/200k 模型分母正确；⑤Claude 正在输出时连续发送至少三条 follow-up，发送和停止按钮应同时存在，消息依次进入同一会话，停止仍可用，320px 屏工具栏不溢出。自动化覆盖 SW 显式 update-aware 注册契约、fallback 时机、toast token/时长、composer 双操作与 context label；真实 iOS SW 生命周期/安全区需真机清账。 | 2026-08-27 |
| V-093 | B-222：Web 待发布 | **iPhone PWA Claude fullscreen 实时滚动与键盘开合回底** | 用 iPhone 主屏幕 PWA 打开一个当前 Claude Code fullscreen tmux 长会话：①单指短拖、连续反向拖动和松手 fling 应贴近手指，不再呈现 60ms+RPC 的阶梯延迟；②滚到历史中部后点键盘按钮展开，动画稳定后应回到最新并恢复 auto-follow；③再次上滚后收起键盘，也应回到最新，输入框/辅助键与终端不得重叠；④运行 `/tui default` 或关闭 mouse reporting 后仍能用旧 RPC 回退滚动；⑤vim/less 不得因键盘开合收到 Claude 的 Ctrl+End；⑥重点观察键盘上方/Home Indicator 附近是否出现白条、关闭键盘后视口是否保持缩短，并记录 iPhone 型号、iOS 版本及竖/横屏。自动化已覆盖 SGR 能力跟踪、非 SGR 回退、wheel 编码/限幅、open/close 回底接线、完整 Web 门禁；WebKit 的 standalone visualViewport/safe-area 问题只能真机清账。 | 2026-08-27 |
| V-092 | B-220：Web 待发布 | **iPhone 结构化对话设置栏、输入区与软键盘布局** | iPhone Safari/PWA 分别用窄屏竖屏和横屏进入普通 Claude 对话：①model / mode / effort 始终同一行等宽，切模型、切中英文、长选项名时只允许单项内省略，不得换行或左右晃动；②输入框初始约三行高，附件/预设/展开/发送固定在下方工具栏，输入从空白增长到长草稿时发送按钮不得横向漂移；③软键盘反复弹起/收起及旋转屏幕，中间消息区不得与 composer 互相覆盖，消息仍可滚动到最新；④展开/收起长草稿、中文 IME 组词和发送均正常。自动化已覆盖 320/390px 单行等宽、72px 最小正文、工具栏分层、长输入按钮横坐标稳定、消息/底栏零重叠和桌面回归；真实 visualViewport/安全区/IME 需真机清账。 | 2026-08-26 |
| V-091 | B-219：Web 待发布 | **移动端返回一次生效 + Claude TUI/长对话滚动手感** | 手机从侧栏进入一个有 structured mirror 的 Claude tmux：①xterm 切结构化再点顶栏 Back，应一次回会话列表，不能先翻回 xterm；反向“回终端”后 Back 同样一次退出详情；②Claude fullscreen/TUI 内单指短拖、长拖和 fling 均应明显比旧版省力且方向正确，桌面滚轮与普通 shell 500 行 native scrollback 不得加速；③先在长会话 A 上滚到中段，再从侧栏打开另一个已缓存长会话 B，首帧应直接在最新消息，不闪中段；④在超长会话上滚很远后点“回到最新”，应立即到底，近距离仍可平滑；⑤上滚回看期间新消息/工具增长不得强拉到底，加载更早消息后位置不得跳。自动化已覆盖 history replace 双向接线、仅 touch alternate-screen 3×、60ms RPC 路径保留、session-key + prepaint reset、browser anchoring 与两屏跳转阈值；真实 TUI 惯性/触摸需真机清账。 | 2026-08-26 |
| V-090 | B-214：zero-downtime rollout（待 Groundwork/Shadow） | **真实发布期间 Web/daemon/session 不断流、不闪 offline** | 先完成生产 Redis/TLS/ACL、Prisma `connection_limit` 和 Caddy ≥2.10.2 门禁；groundwork 后更新 CLI，再对同一 digest 跑 shadow，记录两个 slot readiness、双向 canary、Redis lag、PostgreSQL 连接峰值和附件并发。首次 switch 时持续跑 HTTP/Socket.IO websocket-only/polling-only 探针，桌面与移动 PWA 各保持结构化会话和终端：HTTP 零 5xx；Web/daemon/session 应先连 candidate、完成 resync/RPC registration 再关 old；机器在线态不闪；terminal/tmux 不清屏、不丢键；旧标签页在 compatibility deadline 后能自行恢复。再分别注入 candidate readiness、Caddy reload、post-switch health、Redis、drain、migration 六类失败，核对 active 或 rollback slot 保持健康且无 down migration。 | 2026-08-26 |
| V-089 | B-215：tag 入口 + loading 连续交接（待发布） | **PC 冷启动 loading 不闪烁、不因侧栏右移** | 发布后在桌面普通标签页与 PWA 各做一次真正冷启动：①启动 OrbitLoader 从首帧到 App 可用应锁在整个视口正中心，不得在侧栏出现后向右跳；②不得经历两次消失/重现；③直达首次加载的 `/settings` 重复确认；④会话行右键应显示“重命名 / 标签”，可增删 tag 并保存，终端行仍只显示“重命名”。自动化覆盖 splash 单次撤场、loader fixed viewport 契约、会话/终端菜单语义分流与完整 Web 门禁；动画连续观感需发布后肉眼清账。 | 2026-08-26 |
| V-086 | B-210：Web 待发布 | **iOS Safari / Chrome 添加到主屏幕** | 用未安装 Very Happy 的 iPhone 分别在 Safari 与 Chrome 普通标签页打开 `https://veryhappy.dev`：安装卡片第一步应分别指向 Safari 工具栏分享、Chrome 地址栏旁分享；按“分享→添加到主屏幕→添加”完成后，从主屏幕启动应进入 standalone 模式且不再显示安装提示。另用 iPad Safari（桌面 UA）确认仍识别为 iOS 指引；系统分享面板属于 OS UI，若缺少“添加到主屏幕”，记录 iOS 与浏览器版本后排障。 | 2026-08-26 |
| V-085 | B-210：Web 待发布 | **Android Chrome 原生 PWA 安装面板** | 用未安装 Very Happy 的 Android Chrome 普通标签页打开 `https://veryhappy.dev`（不要无痕模式），等待安装卡片出现：主按钮应显示“安装 Web App”，点击后立即打开 Chrome 原生安装面板；确认安装后应从主屏幕以 standalone 模式打开，刷新不再提示。再卸载 PWA、重新打开站点，Chrome 新的 install event 应覆盖旧的本地“已安装”标记并恢复原生安装按钮。若仍只有手动菜单说明，保留 Chrome 版本、页面 URL、是否无痕、站点设置中的安装状态后再排障。 | 2026-08-26 |
| V-087 | B-211：统一 Usage（待发布） | **Usage 面板桌面/手机深浅主题与真实多 agent 口径** | 发布 Server→Web→CLI 后，先分别跑一个 Claude、Codex、Gemini/OpenCode 会话和一个纯终端，再进设置→Usage：①普通会话/终端会话数量分开且不重复；②各 agent 即使没有 token-count 也应有 session 行，有上报的显示 token；③Claude 多轮总量持续增长，刷新/daemon 重连不翻倍；④Codex 累计快照多次更新不重复累计；⑤无可靠费用的 agent 显示 `—` 而非 `$0.00`；⑥390px 与桌面、深浅主题均无横向溢出，四个 ledger 卡手机为 2×2，趋势/agent 条不使用发光或装饰性 teal。自动化已覆盖归一化、幂等 key、updatedAt 归桶、会话归因、无 token 空态及三包完整门禁；本机缺已安装 agent-browser/playwright CLI，不能冒充真实视觉验收。 | 2026-08-26 |
| V-088 | B-213/B-218：iOS 移动登录修复（待发布） | **iOS 主屏幕 PWA 登录入口、安全区、紧凑首屏与 Google 按钮** | 发布后从 iPhone 主屏幕图标冷启动并处于未登录态：①公开首页应看见且可点 `Sign in`，不得被刘海/圆角裁掉；②必须进入 `/login`，不能落公开 router 404；③竖屏和横屏分别确认四边安全区，登录页不展示桌面品牌 section，320×568 量级短屏在未展开密码时无需滚动；④真实 `Continue with Google` 按钮完整显示到右边框，旋转屏幕后按新宽度重绘且不裁字；⑤聚焦 Email、展开密码方式并弹起键盘，页面应能滚动到验证码/Continue、创建账户和法律链接，Home Indicator 不遮按钮且无横向溢出。自动化已覆盖语义导航、document navigation、四边 safe-area、真实容器测宽、ResizeObserver、320/390px 首屏和 `100dvh`；本地 origin 未获 Google OAuth 授权，生产 GIS 与 iOS standalone/软键盘需真机清账。 | 2026-08-26 |
| V-084 | B-197~201：server/Web/CLI 本批 | **第一台机器交接 + 结构化会话 regional relay 真实跨区体感** | 新账号停在“连接一台电脑”页后连入第一台机器：应立即回到带教程的工作区主页并只弹一次成功提示；刷新、已有机器登录、第二台机器都不得重弹。再用跨区 Web + 新 CLI 发送结构化 Claude 输入、观察首个已完成 block 到达，并断网/停 relay 后重试：中心历史 id/seq 顺序完整、同一 localId 不重复执行、旧 CLI 仍能经中心链路正常对话。分开记录 transport latency 与 Claude SDK TTFT，relay 本批不代表 token streaming。 | 2026-08-26 |
| V-083 | B-040：server/CLI/Web（待发布） | **CLI/daemon 精确版本提示与升级交接** | 配置 relay 的 `CLI_RECOMMENDED_VERSION` 为已批准精确版本后：①在线旧 daemon 在 Web 全局 banner、机器详情、Diagnostics 均显示同一目标，复制命令不得含 `latest`；②离线历史机器不得制造全局 required banner；③320×568 手机/PWA 安装提示出现时更新卡片不得叠压；④执行精确版本 npm 安装后，现有 bundle-mtime 交接应在 60s 内切到新 daemon、保留会话并消警；⑤回滚/清空 relay policy 后重启 daemon，不得继承上代陈旧 required 状态。自动化已覆盖 resolver/route、缓存退避、SemVer、状态分级、dismiss、旧 server fail-open 与 local heartbeat；本项只验真机 overlay 和真实 npm/daemon 交接。 | 2026-08-25 |
| V-081 | B-178/B-179：web `caa53f11`（已部署） | **Android Chrome 终端首弹键盘与 Termux 式滚动手感** | 硬刷新/SW unregister 后用一次性终端：①首次点终端键盘持续打开，不得闪退后要求第二次点；②点键盘按钮可显式开/关，Esc/方向键/快捷指令/退出选择态不得自行唤起；③轻点仍输入，拖动一旦越过阈值松手不得弹键盘；④normal buffer 500 行历史应原生跟手、有系统惯性；⑤vim/less alt buffer 松手有克制惯性，`q` 退出时惯性立即停，不得让 shell 进入 tmux copy-mode；⑥line-input 模式点输出区只收键盘，不得 blur 后又被 xterm 唤回。自动化已覆盖 focus action、compat mouse、gesture latch、fling、buffer transition 与 RPC batch；桌面触摸模拟不能冒充真机软键盘结论。 | 2026-08-25 |
| V-080 | web `de7f5713`（已部署） | **iOS 表单聚焦不再强制放大** | 真机 Safari/PWA 分别点结构化会话输入、助手文字输入、Notes 编辑/筛选、任务编辑、标签改名、登录注册表单：页面不得因聚焦自动放大，输入与中文 IME 正常；再进 terminal 确认 xterm 光标、中文候选位置和底部行输入无错位。自动回归已锁定普通控件/body portal 的 16px floor 与 `.xterm` 结构排除 | 2026-08-24 |
| V-079 | B-149：已部署，待 Owner 限额演练 | **账号容量与已有用户豁免** | 先确认生产 `SIGNUP_MAX_ACCOUNTS` 设置为计划值（建议首发 100）；临时把上限设为当前 Account 数并 `docker compose up -d` 重建容器 → 新密码注册和新 Google subject 都应显示「账户已满」，已有密码/Google 用户仍可登录；恢复上限后检查 Prometheus 的 `registered_accounts_total`、`active_login_sessions_total`、`signup_capacity_remaining`、`signup_rejections_total` 与 Node `process_resident_memory_bytes` | 2026-08-24 |
| V-078 | B-149：已部署，待 Google 外部配置/真机验收 | **真实 Google 注册/登录与浏览器观感** | 在 Google Console 把 `https://veryhappy.dev` 加入 Authorized JavaScript origins；server 从私密部署配置提供 `GOOGLE_CLIENT_ID`，并设置 `GOOGLE_ALLOWED_ORIGINS=https://veryhappy.dev` 和与实际反代拓扑一致的 `TRUST_PROXY`（单层通常为 `1`；GIS popup 不需要 client secret/redirect URI）；按 migration → server → web 发布并硬刷新/SW unregister：①新 Google 账号能创建并进入首页；②logout 后旧 token 和已消费 nonce 都不可重放，再次 Google 登录回到同一 Account；③closed/满额时该已有 Google 用户仍能登录；④错误 origin 返回可恢复提示；⑤明暗主题和手机上按钮、邀请码、错误提示布局正常 | 2026-08-24 |
| V-076 | v0.2.52（已发布） | **attention 跃迁不再被节流吞掉**（review finding 4） | 让 claude 先调 `report_progress` 报个普通进度（attention=none），**10 秒内**再让它报一次 `attention: 'blocked'` → 第二条必须被接受、看板要立刻出现 blocked 标记。修之前第二条会被静默丢弃，且看板最长 15 分钟不更新（analyzer 被自报水位压着） | 2026-08-18 |
| V-075 | v0.2.52（已发布，web 已部署） | **反引号里的文件路径可点**（review finding 1，B-145 主场景） | 聊天里让 claude 写个文件，然后看它正文里 ``已写入 `docs/xxx.md``` 这种**反引号**形式的路径是否可点——这是它写路径的默认形式，也是修复前**完全不生效**的场景。另外确认：①`**加粗**` 形式的路径也可点；②`[label](url)` 这种 markdown 链接里的路径**不该**变成可点按钮（点了应只跳链接、不弹预览）；③长会话（几百条消息）里 agent 流式输出时不卡顿（finding 2 的性能修复）。⚠️ web 有 SW 缓存，先硬刷新 | 2026-08-18 |
| V-077 | B-144：web（先选目录开终端） | **手机上的目录选择弹窗** | 手机端侧栏 + 号 → 「在指定目录新建终端…」→ ①预设 chip 点一下能填进输入框、× 能删；②点文件夹图标展开内嵌浏览器：目录能逐层点进、**文件行是灰的点不动**、底栏「用这个目录」能确认回填；③键盘弹起时弹窗是否被遮（`.ns-backdrop` 在粗指针下靠上 10dvh，输入框应仍可见）；④确认创建后终端应**开在该目录**（终端里 `pwd` 核对）且启动命令在那里执行 | 2026-08-18 |
| V-074 | B-007：cli+web 待发布 | 外部 todo provider —— **失败态**（六种里最容易做砸的） | ①**不配** `todoProvider` 进 /todos → 应给「本机未配置」的引导（含怎么配、指向 docs/channels.md），不是报错也不是空白；②把 command 指向一个不存在的路径 → 明确报错；③指向一个 `exit 1` 且往 stderr 写话的脚本 → **那句话要原样出现在界面上**（显示 unknown error 就是没做到）；④指向一个 sleep 60 的脚本 → 按 timeoutMs 超时，不是一直转圈；⑤新 web + 旧 daemon（没注册这三个 RPC）→ 显示「daemon 版本过旧」而非白屏 | 2026-08-18 |
| V-073 | B-007：cli+web 待发布 | 外部 todo provider —— 正常路径与真实源 | 先用仓库自带示例 provider（`packages/happy-cli/examples/todo-provider-jsonfile.mjs`）配上，在 /todos 里：列出、勾完成、新建各走一遍，确认**每次操作后都以重新 list 的结果为准**（勾完成后该条应按 provider 的实际状态消失/置灰，而不是只有前端变灰）。再接 Owner 真实的 dida/tanka provider 跑一次「看一眼今天要做什么 → 勾掉一条」。⚠️ 多机器时确认面板显示的是**哪台机器**（provider 是每台机器各配的） | 2026-08-18 |
| V-072 | B-132：CLI 待发布 | 自报进度取代 haiku 猜 | 开 `boardLlm: true`，让 claude 跑一个多步任务并在过程中调 `report_progress` → ①看板卡片进度是否即时更新、文案是否像人写的；②daemon 日志里 15min 内应出现 `recent self-report; skipping LLM analysis` 而**不再**起 haiku 子进程；③故意让它连着调两次（<30s）确认第二次被静默节流且没重试 | 2026-08-18 |
| V-071 | B-131：三包待发布 | 预览 overlay 的焦点与 Esc（**spec 被推翻的那条**） | ①正在终端里打字时让 claude 推一个预览 → 确认击键不再落进被遮住的终端；②overlay 打开时按 Esc 应关闭它；③**关掉 overlay 后回 vim 里按 Esc，必须仍是 vim 的 Esc**（回归：不能再全局 capture）；④手机上确认弹出时机与遮挡程度可忍（「不打扰」现在唯一的承担者=localSetting 开关） | 2026-08-18 |
| V-070 | B-131：三包待发布 | 预览四类文件与离线态 | 聊天会话里让 claude 调 `open_preview` 分别指向 md / 图片 / PDF / 源码 → 四类都要正确渲染；再把 daemon 停掉后调一次 → 必须显示「机器不在线」而非空白或转圈；⚠️ web 有 SW 缓存，先硬刷新再判断 | 2026-08-18 |
| V-069 | B-130：CLI 待发布 | 工具面指引真的注入了 | 新起一个聊天会话问 claude「你有哪些 happy 工具、什么时候该用」→ 应能复述行为边界；再在 web 端把会话切到 **local CLI 模式**后新起一轮，同样能复述（证明两种模式都覆盖，`loop.ts` 的切换不会漏） | 2026-08-18 |
| V-068 | B-124：web+cli v0.2.48 | **状态行不再显示成两个** | 终端里让 claude 跑一轮（有转圈的「Shenaniganing…／esc to interrupt」页脚）→ ①观察是否还会同时出现两行；②过程中**改浏览器窗口大小 / 手机横竖屏切换**，再看是否出现残留的旧状态行；③本地 `tmux attach -t vh-<id>` 到同一个终端并改本地窗口大小，web 端应跟着变宽/变窄且不残留。⚠️ web 有 SW 缓存，先硬刷新（或 unregister）再判断 | 2026-08-17 |
| V-061 | B-121：web+cli（终端通道 v2） | **手机滑动跟手（本批的存在理由）** | 手机开一个终端，先 `for i in $(seq 1 500); do echo "line-$i"; done` 造历史 → ①单指上滑回看：应像普通网页一样跟手、有系统惯性、松手继续滑（不再是 200ms 一跳的整屏重绘）；②回看到一半时让终端继续输出（另开一个 `yes` 或跑个 build）：视口应**停在原处不被拉底**；③滑回底部后新输出应继续跟随 | 2026-08-17 |
| V-062 | 同上 | alt↔normal 切换的手感断层 | 终端里 `vim` 或 `less`（进 alt 屏）→ 滑动应仍走旧的 RPC 轨（能滚，但不跟手，这是预期）→ `q` 退出 → 第一下滑动是否立刻回到跟手的本地轨（`onBufferChange`→class→touch-action 有一帧延迟，可能第一下落在旧轨）；退出后 scrollback 应完整（alt 帧不许污染回看历史） | 2026-08-17 |
| V-063 | 同上 | 深历史重建的「无感」程度 | 手机把 app 切后台 ≥10 分钟（或锁屏一晚）→ 回到终端页：应先秒出当前屏，几秒内在**用户没在选择、视口在底部**时整屏重画一次补上深历史。观察：这一下重画是否可察觉/是否打断正在做的事；若正在选择文字或正滚在半空，重建应**挂起不打断** | 2026-08-17 |
| V-064 | 同上 | 极端刷屏下的前端帧率与 daemon CPU | 终端里跑 `yes b121-flood`（或大 build 日志）30s → ①手机/桌面页面是否卡死或掉帧到不可用；②`top -pid $(pgrep -f 'very-happy.*daemon')` 看 daemon CPU 是否失控；③停止后终端是否仍可交互（本批**不开** tmux pause-after，靠 tmux 内建限速+xterm 队列+2MB ring 三层兜底，恶化则记 backlog 上 pause） | 2026-08-17 |
| V-065 | 同上 | 本地 `tmux attach` 与 web 并存的观感变化 | mac-office 上 `tmux attach -t vh-<id>` 与手机同看：①v2 不再踢本地 client，两端应能同时看；②本地改窗口大小后 web 侧应跟随（`%layout-change`）；③**本地 split 一个 pane 后，web 只镜像首个 pane**（新 pane 内容不可见）——这是设计变更不是 bug，确认可接受 | 2026-08-17 |
| V-066 | 同上 | 存量 alt-屏 claude 零增益（预期） | v2 之前创建、没有 classic-renderer env 的老终端里跑 claude → 回看仍走 alt 轨 RPC、本地 scrollback 近空。**零增益是预期**，只需确认没有比 v1 更差 | 2026-08-17 |
| V-067 | 同上 | CJK/emoji 宽度与折行 | 终端里输出中文长行、emoji、中英混排（`for i in $(seq 1 30); do echo "第 $i 行 中文宽度测试 🙂 mixed"; done`）→ ①当前屏与回看历史里的折行位置是否一致、有无错位重叠；②手机窄屏与桌面宽屏各看一次（tmux 与 xterm 的 Unicode 宽度是**两套独立裁决**，spec 风险 8） | 2026-08-17 |
| V-060 | B-112：web（9017ae9b 后首个部署） | Fold 8 折叠屏布局 | ①展开内屏横放/竖放：应出现双栏（侧边栏+详情，侧栏可收起成 46px rail）；通知/剪贴板面板应是浮层而非全屏；②折上外屏：仍是单栏手机布局；③普通手机横放：仍单栏（高度不够，不该误入双栏）；④【B-113 定性】半折竖放（Flex mode）在会话页打字：键盘是否自动占下半屏、UI 是否被正确压到上半且输入框可见——把观察结果告诉主 agent 定 B-113 ② 的范围 | 2026-08-16 |
| V-058 | B-107：web+cli v0.2.44 | 镜像输入条真机 | 手机进结构化镜像 → 底部输入条中文 IME 输入回车 → 文本应出现在终端里的 claude 输入框并已提交，几秒后自己的消息回流镜像；claude 退出后输入条应消失（或发送被拒并提示）；老 CLI 机器应提示升级而非静默失败 | 2026-08-15 |
| V-059 | B-108：同上 | context meter 复活 | ①普通会话发一轮消息后，composer 状态行的 context 百分比应有非零读数（此前全坏）；②镜像横幅右侧同样出现读数；③/compact 后 meter 应回落 | 2026-08-15 |
| V-055 | B-105：web+cli v0.2.43 | 终端镜像·移动端主场景 | 手机上先跑 `very-happy install-terminal-hooks`（mac-office 已装则略）→ vh 终端手敲 claude → ①终端 header 应出现结构化 toggle（一眼可达不藏菜单）→ 切换后聊天视图渲染（工具特化/复制/thinking）、无输入框、顶部只读横幅；②设置→终端→默认视图选「结构化」→ 从侧栏新开一个跑 claude 的终端应自动进结构化（注意：绑定推送晚于进页 3s 则该次不自动跳，亮 toggle 为正常）；③镜像页「回终端」按钮可跳回 | 2026-08-15 |
| V-056 | 同上 | 镜像滞后体感与打字延迟 | ①claude 流式输出中在 xterm ↔ 结构化间来回切，观感是否可接受（镜像慢半拍是预期，横幅已声明）；②两三个终端同时跑 claude 镜像时，终端打字延迟应无可感退化（M2 offset-tail 的验收面） | 2026-08-15 |
| V-057 | 同上 | needs_input 横幅与死后历史 | ①让终端里的 claude 卡在权限对话框 → 手机结构化视图顶部应出显著「claude 正在终端里等待输入」横幅，点击切回 xterm；②关闭该终端 → 侧栏归档「已结束终端」记录应有「查看结构化历史」入口，点开是完整镜像历史；③看板/通知/⌘K/机器页确认无 mirror 会话泄漏 | 2026-08-15 |
| V-052 | B-103/104：web+cli v0.2.42 | 默认模型语义与新 SDK | ①新建普通会话不动任何选择器发一条消息 → meta 行显示的模型应为 **opus[1m]**（机器 /model），效果=与本机 claude 一致；②effort 选择器应显示「默认」而非 low，选 high 再选回「默认」下一条消息生效；③选 fable 5 应真跑 claude-fable-5（meta 行核对）；④老会话若之前 sticky 了 opus/medium，发消息后应被重置为机器默认 | 2026-08-15 |
| V-051 | B-097~102：聊天 UI 打磨批 | 聊天渲染与交互 | ①长代码块应显示「展开全部（N 行）」而非被裁掉，亮暗两主题渐隐遮罩观感；②composer 展开按钮：长 prompt 编辑到 60vh、收起还原、焦点不丢；③跑个长输出任务：贴底时工具输出增长应持续跟随，上滚回看不被拉回，跳底按钮出现「N」badge；④plan 模式跑一次：ExitPlanMode 的计划应为 Markdown（转录+权限卡両处）；⑤让 agent 用 AskUserQuestion 提问：选项应为可点按钮，点选后答案作为用户消息发出、模型正确接续；⑥thinking 流式时自动展开、结束折回、收起有首行预览；⑦长用户消息折叠展开；⑧diff/thinking/权限卡参数可复制 | 2026-08-15 |
| V-041 | B-094：web e89f3e23 | prompt 笔记面板 | ①⌘J/侧栏 footer 便签图标/⌘K「笔记面板」开右侧 dock，桌面应**挤压**聊天与终端而非悬浮，拖 handle 调宽刷新后记住；②聊天页新建笔记自动绑当前会话（chip 可跳转），写字后另一设备秒级同步；③「插入到输入框」聊天=追加不发送、终端=粘贴不回车（多行也不执行）；④/notes 全屏视图列表+筛选，移动端 dock 应为全屏浮层+软键盘编辑体验（IME）；⑤在 /board 上点插入应提示「当前页面没有输入框」 | 2026-08-14 |
| V-040 | B-091/092：web+cli v0.2.41 | tag 体系与助手反馈 | ①meta 会话应从侧栏/看板/命令面板/badge 全部消失（/assistant 与直达 URL 仍可用）；②助手派的任务带 assistant tag chip；③侧栏 Tags 按钮分组视图、priority 标记 warn 色置顶（两主题观感）；④按住说话应有提示音+按钮弹跳+电平条（Android 还有震动；iOS 无震动为预期）；⑤助手工具活动显示友好名+参数摘要 | 2026-08-14 |
| V-039 | B-088：web（v0.2.40 后首个部署） | 文件浏览器分栏+拖宽 | 桌面：终端开文件抽屉应挤压终端而非悬浮；拖 handle 调宽流畅、松手后终端**无右缘截断/末行被裁**（铁律 6 形态）；会话页文件栏同样可拖宽；宽度刷新后记住。手机/iPad：抽屉形态应与之前完全一致 | 2026-08-14 |
| V-038 | B-087：web+cli v0.2.40 | 文件预览升级 | ①两宿主（终端抽屉/FilesPanel）长文件滚到底；②.md 渲染/源码切换；③>512KB 图片分段加载+点击缩放；④PDF 桌面内嵌预览 + **移动 Safari PDF 表现**（已知可能只渲染首页，刚需再上 pdf.js）；⑤全屏进/退（按钮+Esc）；⑥旧 daemon 开大文件应提示升级 | 2026-08-14 |
| V-035 | B-083/084：web+cli v0.2.39 | 归档语义与已结束终端 | ①会话行菜单应无「删除」只有归档；②关闭一个跑着 claude 的终端（文案应中性提及 --resume）→ 侧栏归档视图出现「已结束终端」记录 → 点「在同目录开新终端」→ 新终端 `claude --resume` 找回对话；③离线机器该按钮禁用 | 2026-08-14 |
| V-036 | B-085：同上 | 待处理行醒目度 | 让一个会话卡在权限请求 → 侧栏该行应有 accent 左边条+加粗+光晕点，一眼可辨；普通跑完未看的行只有白点不染 teal；选中态与待处理叠加不打架；亮暗两主题都看 | 2026-08-14 |
| V-037 | B-081/082：同上 | 中文音色与机器改名 | 设置→Voice→「浏览中文音色库」试听+添加即选中，下一轮 TTS 用新音色；设置→机器→改名后侧栏/助手处处生效 | 2026-08-14 |
| V-032 | B-069：web b069-voice-streaming + cli 0.2.38（daemon 已装，npm 待发） | 双向流式语音 | PC+手机：按住说话应出实时字幕（设置里先选识别语言=中文）；长回复应 <1s 开始出声、字幕逐句推进；断网/挡 token 时应静默回落整段模式不报错 | 2026-08-14 |
| V-033 | 同上 | 主动汇报闭环 | /assistant 让助手派一个小任务 → 任务完成后 ≤1min 助手应主动开口汇报一句结论（不复读通报原文）；自己手开的普通会话完成不应触发汇报 | 2026-08-14 |
| V-034 | 同上 | PC 右侧常驻文字栏 | ≥1100px 开文字记录应为右侧固定栏（语音台居中不被盖住），窄屏仍是浮层；开关状态刷新后保持 | 2026-08-14 |
| V-022 | cli v0.2.34 + web d5e3c5f2 | iOS Safari 按住说话全链路 | 真机 Safari（非 PWA）：/assistant 启用语音→按住说话（长按不弹菜单/不选中）→松手转写→回复 TTS 出声；静音拨片拨到静音再试一轮仍应出声 | 2026-08-13 |
| V-023 | 同上 | 真实 STT/TTS 与 speaking 态 | 需 prod（有 ELEVENLABS_API_KEY）：说中文→转写正确→回复朗读、speaking 波形动效；设置里换音色下一轮生效；PTT 按下打断播报 | 2026-08-13 |
| V-024 | 同上 | Android Chrome 同链路 + 双主题观感 | Android 真机重复 V-022；明暗两主题看 logo 四态动效观感与文字可读性 | 2026-08-13 |
| V-025 | 同上 | 文本输入 IME + 键盘视口 | /assistant 底部输入框中文 IME 组词回车不误发；软键盘弹起不遮挡、收起后布局恢复 | 2026-08-13 |
| V-026 | 同上 | assistant 派活闭环体验 | 语音/文字让 assistant 用 session_spawn 派一个真实小任务→跟进→汇报；kill/archive 前有复述确认 | 2026-08-13 |
| V-001 | v0.2.29+web 5500201a | 切输入法卡死自愈 | 中文打一半（气泡留字母）→ 切英文 → 切回中文打字，应立即恢复；claude 输入框无残字 | 2026-08-13 |
| V-002 | 同上 | 终端删除不复活 | 删除一个打开中的终端 → 自动跳走 → 刷新页面不再出现 | 2026-08-13 |
| V-003 | 同上 | 右键菜单关闭后直接打字 | 侧栏行右键/更多菜单开关后，回终端不点画布直接打字有效 | 2026-08-13 |
| V-004 | web 075d0116 起 | 泳道拖拽手感 + 触屏长按右键菜单观感 | 看板 Tasks 布局拖泳道；手机长按卡片 | 2026-08-13 |
| V-005 | web e46380be 起 | 亮色灰调整体观感 | 亮色主题过一遍列表/终端/设置/弹窗 | 2026-08-13 |
| V-006 | v0.2.30+本批 web | 看板生命周期视图 | /board 默认三列：进行中/等我看/已完成；跑完的会话落"等我看"，✓ 一键完成即消失并进 Tanka 通知 | 2026-08-13 |
| V-007 | 同上 | 侧栏任意行拖拽 | 直接拖任何 session 行到顶部=置顶落位，拖出=取消；第二台设备顺序一致 | 2026-08-13 |
| V-008 | v0.2.30 | tmux 绿条消失 | 新开/重开终端无底部绿条，滚动回看仍有右上位置指示 | 2026-08-13 |
| V-009 | 同上 | 中文输入法稳定性观察 | 日常使用中/英切换若再坏：先跑探针留证+记录前一个动作 | 2026-08-13 |
| V-010 | web 66546248 | 侧栏任意排序 | 拖任何行到任何位置；第二台设备顺序一致；新会话出现在顶部 | 2026-08-13 |
| V-011 | 同上 | 侧栏状态模式 | 三段切到「状态」：等我看/进行中/已完成分组与看板一致；⌘1-9 跟随；iOS 搜索图标唤起 ⌘K + #tag 过滤 | 2026-08-13 |
| V-012 | web b147c7ac | 移动端键盘打磨 | ①首弹不再鬼畜②键盘态 claude 输入行始终可见（钉底+瘦身+小字号合效）③11px 观感④键盘收起完整还原⑤移动端无收起侧栏按钮 | 2026-08-13 |
| V-019 | feat/clipboard-ux 分支（待合并） | copy_to_clipboard 新体验 | ①页面聚焦时收到推送=不弹窗、直接复制+toast 预览 ②页面后台/未聚焦（尤其 iOS PWA）=常驻可点 toast，点击应真的落进剪贴板 ③⌘K「剪贴板历史」与设置→Channels 入口打开面板，条目点击复制、展开编辑后复制、单删/全清 ④「收到时自动复制」关掉后只出点击复制 toast ⑤移动端面板全屏观感 | 2026-08-13 |

## 已清账（留最近 10 条，更早的看 git 历史）

| id | 版本/批次 | 验证项 | 结果 | 清账日期 |
|---|---|---|---|---|
| V-013 | 终端通知：终端里让 claude 跑个长任务，结束后 10-30s 内奇妙通知群应有「等待下一步指令」+终端链接；权限请求同理 | 2026-08-13 | B-012 |
| V-014 | 终端快捷指令：PC header 书签图标 / 移动端快捷键行入口，选中后文本进 claude 输入框且不自动回车、焦点回终端 | 2026-08-13 | B-013 |
| V-015 | 复制体验：代码块/工具输出 hover（移动常显）复制按钮、整条消息复制；移动端复制按钮是否遮首行文字（agent 自报风险点） | 2026-08-13 | B-014 |
| V-016 | 移动端 diff 默认折行、行号对齐；iOS 页面无橡皮筋回弹、下拉刷新已禁 | 2026-08-13 | B-014/B-015 |
| V-017 | mac-office 手动跑一次 vh-update（ssh 身份文件缺失我连不上；本机已到 0.2.32） | 2026-08-13 | 发版 |
| V-018 | 通知中心：铃铛 badge/面板/全部已读；提示音在设置→通知里选音色试听（首次要点过页面一次才解锁声音）；首次打开不应出现未读风暴 | 2026-08-13 | B-018 |
| V-020 | 文件浏览器：终端 header 文件夹图标→抽屉浏览 cwd；聊天「文件」面板第三个「浏览」tab；点文件看内容/复制路径；图片内联预览 | 2026-08-13 | B-047 |
| V-021 | ⌘. 弹快捷指令菜单（聊天/终端都试）+ 按数字直选；Web Push：手机 PWA 锁屏收终端完成通知并点击直达 | 2026-08-13 | B-045/B-048 |
| V-022 | 快捷指令合并：设置页只剩一个「快捷指令」组，原终端快捷命令已自动并入且仍是「插入不回车」；需要自动执行的自己开开关 | 2026-08-14 | B-052 |
| V-023 | 侧栏最近活跃排序：刚聊过的浮到最上；鼠标停在列表上时不抽走行；点排序图标切回手动排列应原样恢复 | 2026-08-14 | B-070 |
| V-024 | 全局返回：各页左上返回键行为、⌘[（终端内也生效）、移动端左边缘滑动（终端页需明显水平长划）、深链/刷新后回父级 | 2026-08-14 | B-071 |
| V-025 | 通知已读跨设备：手机收到通知 → 电脑上点开那个会话停留 1 秒 → 手机 App 内红点/条目应自动消失（系统横幅不保证） | 2026-08-14 | B-066 |
| V-026 | 铃铛在侧栏底部与设置同排、未读 badge 不被裁；侧栏收起时铃铛也在底部不跳 | 2026-08-14 | B-065 |
| V-027 | 实时活跃排序：两个终端同时刷屏，列表上浮应平稳不抽搐（1s 上限）；刷屏时把鼠标停在列表上，行不应位移（8s 冻结） | 2026-08-14 | B-067 |
| V-028 | 手机+桌面同开：桌面上打字不应把手机的列表顶动（本机打点不同步），但终端输出会（远端通道） | 2026-08-14 | B-067 |
| V-029 | 侧栏选中态：亮暗两主题下「哪行是打开的」一眼可辨；鼠标划过其它行时选中行不失色；移动端按下有回馈 | 2026-08-14 | B-072 |
| V-030 | ⌘W：PWA 内弹应用内确认、取消后焦点回终端（回车能打字）；普通标签页 ⌘W/⌘R 弹浏览器原生对话框；自动更新的刷新**不应**被拦 | 2026-08-14 | B-073 |
| V-039 | IME 主症状正面验证：⌘K→Esc / ⌘R→Esc / 新建会话弹窗→Esc 之后**直接敲中文和英文**都能进 PTY | 2026-08-14 | B-093 |
| V-040 | 合成到一半点 macOS 菜单栏输入法菜单、或 alt-tab 出去再回来：已敲的拼音**不丢**（CDP 难忠实复现输入法菜单的 blur 时序） | 2026-08-14 | B-093 |
| V-041 | 看门狗不误伤：弹窗输入框/笔记 dock/文件浏览器过滤框打字时焦点不被抢；Radix 菜单开着时上下键仍归菜单；侧栏拖选文字后选区不被清 | 2026-08-14 | B-093 |
| V-042 | 诊断钩子可用：debugMode 下 console 取 `window.__vhTermDiag.snapshot()`，能区分「看门狗没触发」与「触发了但被浮层/合成挡住」 | 2026-08-14 | B-093 |
| V-043 | **新输入路径已默认开启**：桌面正常打中文（拼音就地显示在光标处）、切输入法/alt-tab 回来拼音不丢、vim/claude TUI 逐键交互正常 | 2026-08-14 | B-093 Step3 |
| V-044 | iOS：软键盘弹起后**布局能还原**（Step 2 把 overlay 字号抬到 16px 就是防 iOS 自动放大导致键盘避让整个停摆——最高危项）；退格能删到底；中文合成气泡观感 | 2026-08-14 | B-093 Step2 |
| V-045 | Android/Gboard：滑行输入、退格触发重组合、Enter 不误发 | 2026-08-14 | B-093 Step2 |
| V-046 | iPad+硬件键盘（粗指针但真键盘）：拿到的是移动端几何+桌面路由表，逐键交互是否正常 | 2026-08-14 | B-093 Step2 |
| V-047 | macOS 上 Ctrl+K/J/N/R 现在应能进终端（readline 的 kill-line/换行/下条历史/反向搜索） | 2026-08-14 | B-095 |
| V-048 | 出问题时的逃生门：设置→终端输入方式 切回「xterm（旧）」应立刻恢复今天之前的行为，**不需要发版** | 2026-08-14 | B-093 |
| V-049 | **新路径三修后手测（`?input=own`）**：打「ni hao」+空格——① 拼音处应出现明显的**不透明气泡+teal 描边**（不再和终端正文同色）②不再有 3px teal 光晕方框 ③中文能正常进终端 ④合成到一半停手 10 秒再选字，**拼音不应以英文泄漏进终端** | 2026-08-14 | B-093 |
| V-050 | 合成气泡宽度是 40 列的不透明框（旧路径气泡贴合内容宽）——**行中编辑（vim）时会盖住光标右侧的字**，是否需要改成贴合内容宽 | 2026-08-14 | B-093 |
