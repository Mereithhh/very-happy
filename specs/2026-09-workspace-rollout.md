# 统一工作台：实施与功能保留台账

状态：Shipped · 2026-09-10 · PR #320 · 6d337987d65c14f8bf8501263f797d6b88881f60。
唯一视觉标准：`docs/design-language.md`。本台账记录实现/验证，不复制视觉标准。

## 完成标准

全部生产页面采用统一风格，真实能力不因原型缺省而丢失；组件复用、废弃代码清理与包体对比完成。
AGENTS/CLAUDE/项目 skill 共用设计入口。文档站、Landing、README 截图和用户更新通知同步。
自动化可验的项目当批验完，真机专属行为明确登记。所有门禁通过并完成整体 review 后再按当前授权发布。
本地设计确认不等于功能验收，不以原型替代生产页面。

## 迁移矩阵

| 区域 | 功能与边界 | 实现状态 | 验证证据 |
|---|---|---|---|
| 设计系统入口 | AGENTS、CLAUDE、共享 skill、tokens 单一来源 | 已写入 | skill quick_validate 通过；Claude 链接指向同一 skill |
| 共享基础 | 字体/间距/焦点、按钮、菜单、表单、弹层、布局；终端例外 | 已迁移；最终包体审查完成 | 第 1/14/15 批：mobile 17px、quiet focus、未定义 CSS token 清零；整合 2729 测试通过 |
| 导航/会话列表 | 新建所有选项、搜索/快捷键、分组/排序/标签/归档/终端/团队、右键拖排、帮助/待办/笔记/主题/通知 | 真实 Sidebar 已迁移；分组/拖排/标签编辑/归档视图复验通过 | 第 24/27/29 批：新建 7 路径、右键、分组与排序可达；桌面行高 32px，手机 44px；服务端标签保存仍由原 owner 负责 |
| 会话头部与正文 | backend/机器/relay、上下文、实时 loading/双向 token、自动跟随、工具详情、消息操作、分支编辑 | 真实顶栏与固定单行状态已迁移；跟随和原位编辑已复验 | 第 2/28 批：流式跟随/上翻暂停、原位编辑取消与手机 17px；metadata.flavor 驱动身份 |
| 输入区 | 单一主控件、队列/steer/stop、权限/model/effort、附件/快捷指令/语音/侧问 | 样式迁移与触屏复验完成；基线保留 #317/#318 行为 | 第 28/30/35 批：单主按钮、队列、编辑、最高档、预设和附件六组验证；未执行模型请求 |
| 右侧标签面板 | 文件/改动/笔记/概览/预览；按会话隔离、保留草稿、尺寸/移动全屏、菜单拖排 | 文件/笔记/侧问/子代理/网页已统一；当前会话内收起保留挂载 | 第 4–18/22 批：跨类型拖排、身份隔离、草稿/已挂载滚动、真实网页与面板尺寸验证 |
| 终端 | 新建/attach/恢复/关闭与终止差异、侧栏、标题/键盘/字体/拷贝/文件 | 右栏和选择页已迁移；真实配对/新建/刷新恢复/文件/笔记/attach/断开与结束已验 | 第 18/19/25/31 批：真实隔离 daemon + 私有 tmux；桌面和 coarse 手机验证，原生 IME 留真机项 |
| 设置 | 所有子路由、机器/账户/模型/权限/快捷指令/通知/团队配置；搜索/导航/控件 | 共享布局已迁移；完整路由与保存回调差异审查完成，快捷指令实际服务端保存已验 | 14 个真实路由 × 6 组尺寸/主题；第 24 批隔离服务验证跨浏览器快捷指令持久化 |
| 团队/待办/笔记/帮助 | 当前全部真实操作与错误/等待/空状态，运行概览仍可达 | 真实页面样式已迁移；笔记/待办/团队设置归档联动与任务状态呈现已验 | 第 9/14/24/26/35 批：组件排版/任务状态 + 隔离服务笔记/待办/团队验证 |
| 启动与系统状态 | prepaint + React 一致、SW/超时恢复不变；更新提示/历史、空/错/离线/审批 | 启动与更新已迁移；离线/审批/终端失败真实组件六组布局通过 | 第 8/13/20/36 批；两个真实构建验证 controllerchange 和新入口，旧资源保留；本轮不发送真实审批或模型请求 |
| 语音助手 | 静止品牌、四态反馈、转录与审批入口、触屏操作 | 已统一 Logo/触控样式，保留语音业务实现 | 第 33 批：真实组件四态渲染、六组 CSS 前后证据、152 项语音测试；未模拟真实麦克风 |
| 通知/剪贴板 | 全屏手机面板、已读、历史编辑/删除/清空与跳转 | 已补齐原先遗漏的手机定位与点击区 | 第 32/34 批：六组真实组件/页面交互，手机 44px/17px，数据 owner 未替换 |
| 登录/注册/连接 | 移动居中、品牌、OTP/密码/Google/邀请码/容量/重认证/二维码 | 登录/注册手机表面已统一；真实配对和公开认证状态复验已覆盖 | 第 25/27 批；OTP 错误/更换邮箱浏览器验证；真机 V-080 |
| Landing/文档/README | 抓眼球品牌与新 UI 截图、导航、教程、无旧图误导 | 共用产品预览和 README 两张截图已更新；文档章节/目录、Landing/认证/法律公开页布局已全覆盖 | 第 12/23/27 批：真实组件截图、示例标注、文档 192 组与公开页 108 组检查；手机触屏截图以第 27 批为准 |
| 清理/性能 | 删除被替代原型/组件/资产；检查 imports/动态 routes；入口与 lazy chunks 对比 | 已删除废弃 App 展示页和旧 loading CSS；最终构建依赖图对比完成 | 第 21/31 批：匿名首页不引入 AppRoot；生产 manifest 无 DEV harness，无新增依赖 |
| 用户通知/发布 | changelog、全门禁、功能 review、真实上线验收 | sep10 中英文重大更新提示已上线；PR #320 / 6d337987 发布成功 | 第 23/36/37 批与文末生产验收；精确 SHA、镜像、健康、资源和 18 组生产页面检查通过 |

## 执行顺序

1. 固化标准、盘点真实路由与组件；记录构建基线。
2. 共享基础与导航；保留数据/快捷键/行为 owner。
3. 会话、输入、标签面板与终端；逐能力验证。
4. 设置与业务页面、全量系统状态。
5. 公共页面、品牌图、实际截图、文档与 README；清理旧实现。
6. 全部功能矩阵、门禁、性能与发布审查。

未完成区块继续保留在台账中，不以“全局改了 CSS”视为整站迁移完成。


### 首批实施记录

复用真实 Sidebar 的 ActionDropdownMenu、ActionContextMenu、rowMenuItems、排序/分组/恢复机制，不引入新导航库。新建成为常用导航，帮助/搜索显式可见；运行概览移到列表菜单，在列表/状态/归档均可达。Logo 使用现有资产。
全局新增 15/17px 字号 token，普通移动输入 17px，xterm helper 仍保持独立 16px；移除基础控件外侧发光，使用内侧/底色焦点反馈。新增 fs-15 同时消除已登记的 undefined token 债务。
构建比较基线为本轮实施前的 `build-login-final.log`：4894 modules、index 192.07kB（gzip 61.13kB）及另一个 index 60.71kB（gzip 21.21kB）；最终需按 entry 依赖图比较而不是仅比较同名 chunk。
当前验证仅证明首批区域，不能据此把设置、标签面板、终端、公共截图或全站迁移标完成。

首批门禁：Web 全量 296 文件 / 2698 测试通过，tsc 退出 0；3 个关键源码断言变异均被捕获。侧栏默认宽改为 260px，尊重用户已保存宽度。基线与首批构建均为 4894 modules，主要 index chunk 为 192.07kB / gzip 61.13kB，没有因迁移增加初始依赖。真实 Sidebar 的开发 fixture 用于 UI 验证，不对接生产数据。


### 第二批：真实会话状态与顶栏

- SessionLiveStatusBar 保留 agentLiveness/heartbeat 租约、进度来源与计量语义。单行直接显示阶段/工具、耗时、输入/输出；native details 展开缓存与估算思考，不把估算当精确输出。
- ChatList 在加载/空/普通分支统一保留固定状态槽，镜像只读模式不显示；PermissionCard 仍在对话内容区可见。状态不随 transcript 增长移动；回最新按钮上移避免遮住计量。
- ChatHeader 显示真实 metadata.flavor 身份，缺失明确 unknown。机器与 Agent 同栏，完整路径在复用的 Radix Popover 中查看；重命名、文件、侧问、笔记、组建团队能力门控保留。
- 浏览器真实组件检查 1280/390/320 × 明暗：输出增长仍贴底（误差 ≤0.5px），主动上翻后 scrollTop 保持 0，状态槽高度固定桌面 32px/手机 44px；展开详情不推挤页面，身份弹层不越屏。测试页曾因 grid 的默认 min-content 溢出 7px，修为 minmax(0,1fr)，未用隐藏 overflow 掩盖。
- Web 全量 297 文件 / 2706 测试通过；tsc/build 通过。固定槽和绝对定位详情两条源码回归变异均被捕获。此批不是右侧多标签、设置、终端或公共页面的完成证明。


### 第三批：真实设置布局

- SettingsLayout 共用页面/标题/分类导航，SettingsRoutes、VoiceSettings、MachinesSettings 删除重复外壳。保留 14 个实际路由及原有保存回调、权限与认证逻辑。
- AppLayout 的设置路由使用独立分类导航，保留 NotesDock 与全局快捷键；DEV 验证路由仅复用真实页面，不新增生产依赖。
- 手机分类选择器和按需分类搜索；全部长设置标题允许换行，选中项使用中性底色与勾选，不再画绿色装饰条。
- 真实 Chromium 1280/390/320 × 明暗，14 路由逐项可达，无横向页面溢出；搜索单一分类/无结果和手机开合验证通过，手机可编辑控件 17px。
- css-probe 使用同一设置行 DOM 对比 HEAD/当前 CSS：320px 标题内部溢出 86px → 0，nowrap → normal；选中色条阴影 → none。这里只证明排版，不冒充服务端设置保存验证。
- Web 全量 297 文件 / 2706 测试、tsc 与 Vite build 通过；无新增第三方依赖。

### 下一批的现况约束：统一右侧标签

现有 SessionDetailScreen 通过 URL panel 切换 FilesPanel/BtwPanel/SubagentPanel；FilesPanel 内部只有一个 selected 文件，FsBrowser 另有浏览状态。NotesDock 在 AppLayout 负责认证 bootstrap、Cmd/Ctrl+J、全局笔记标签和 split 编辑。这些都是实际能力，统一标签不能直接删除 NotesDock，也不能把全局笔记归属误改成 session 数据。
迁移需保留旧 panel URL 的深链兼容；按 session 保存文件/侧问/子代理目标与标签状态，笔记正文仍由 notesStore 唯一持久化。终端关闭标签不得触发 PTY 终止。浏览器标签需要真实加载/失败处理，不能把文件 Browse 标签当网页浏览器宣称已完成。

#### 标签状态实现约束（本地 Web，定稿）

首步抽取可复用 WorkspaceTabs 和纯标签操作；文件预览按完整路径去重，关闭活动标签选相邻项，拖排不改变当前内容，键盘左右/Home/End 与菜单移动等价。FilesPanel 复用现有 FileView/useSessionFiles，文件标签切换保留已挂载内容。会话、机器和目录共同构成视图身份；身份变化重建组件，禁止上一会话 selected 路径穿透。此阶段无 wire/schema/服务端变化，不增加依赖，不改文件写入语义。后续统一 Notes/Btw/Subagent 的组合容器继续遵循上文能力约束；文件标签不是整个右侧工作区完成的替代。


### 第四批：真实文件多标签与共享标签组件

- WorkspaceTabs 复用现有 Radix 菜单，无新依赖；文件完整路径去重，键盘左右/Home/End/Delete、右键与手机菜单移动/关闭、桌面拖拽。工具分类不参与文件排序。
- FilesPanel 保留原有 useSessionFiles/FileView/FsBrowser，旧单 selected 预览升级多文件标签，删除旧 fp-head/fp-tabs 样式。session/机器/目录构成 identity，内存仅保存标签标题与路径，不把正文写入新存储、不改 wire 或 synced settings。
- 浏览器实际捕获隐藏/重排后的 scrollTop 归零；WorkspacePane 显式记录嵌套滚动偏移并恢复，新增行为回归测试。六组 1280/390/320 × 明暗验同名文件、两会话隔离与返回、菜单排序、桌面拖拽、键盘关闭与滚动保持 200px。手机标签关闭 44px，页面无横向溢出。
- DEV /dev/workspace-files 使用真实组件和明确示例数据，refreshOnMount=false 不访问虚构机器；生产默认刷新不变。
- 全量 Web 在初版新增组件后 298 文件/2710 测试通过，后续追加滚动和身份验证 6 项定向测试通过；最终 tsc/build 退出 0。css-probe 前后检查：移动关闭按钮 36→44px。
- 未完成：目录浏览切换状态、关闭面板后的滚动恢复、统一 Notes/Btw/Subagent/网页预览、整个工作区尺寸/终端接入与全站最终门禁；本批不代表统一右侧面板整体完成。

### 第五批：侧问/子代理入栏，笔记复用交互

- SessionWorkspacePanel 将真实 FilesPanel/BtwPanel/SubagentPanel 组合为单一标签栏，保留旧 panel/sub URL、侧问能力守卫、后台请求与草稿 store。子代理标题来源仍为真实消息 summary，隐藏重复标题栏。
- 侧问只有当前标签激活时聚焦，切到文件不抢输入；关闭标签不调用 cancel。右键“关闭其他标签”一次更新工具列表并选择目标，避免逐项关闭的旧 URL 重新打开已关闭项。
- 笔记 Dock 复用 WorkspaceTabs，保留 NotesStore bootstrap、Cmd/Ctrl+J、split 编辑、新建、固定、删除清理、全屏与绑定；新增固定标签排序，仅写 notesOpenTabs。清理旧 notes-dock-tabs/label/close 的重复 CSS。
- 六组真实组件浏览器检查（1280/390/320 × 明暗）：文件/侧问/子代理切换保持单一栏；草稿在切换、关闭其他标签、重新打开后保留；笔记排序、切换草稿、关闭标签不删笔记通过。
- Web 全量 299 文件 / 2712 测试通过，后追加笔记排序的 2 项测试与相关定向 11 项通过；tsc/build 通过。旧 wiring 测试迁至新 owner，两条接线变异均捕获。
- 剩余：笔记还使用独立容器，需与会话 workspace 合并且不重复 bootstrap/快捷键；网页预览、运行概览、终端与整体面板尺寸还未完成。不能把复用标签外观当作全部功能已整合。

#### 笔记容器合并约束（本地 Web，定稿）

NotesDock 保留唯一快捷键/认证 bootstrap/删除标签清理职责；提取共享笔记视图 hook，由独立 Dock 或会话 Workspace 渲染。会话路由中全局 Dock 不再输出第二个 aside，`panel=notes` 承载当前视图；notesPanelOpen 继续是全局入口/快捷键信号，打开会话笔记同步 URL，选其他工具或收起时设 false。固定笔记标签、正文与绑定仍由原 notes localSettings/notesStore 所有，不复制到 session store；session 工具状态只记录是否曾打开笔记入口。关闭笔记入口不删除笔记正文或全局固定标签。

### 第六批：笔记容器合并与标签操作收敛

- 提取 useNotesWorkspace 共享视图：独立 NotesDock 与 SessionWorkspacePanel 使用同一内容/标签/动作定义。会话路由不再输出独立 notes aside；全局 NotesDock 仍唯一负责认证 bootstrap、Cmd/Ctrl+J 与跨设备删除后的标签清理。
- 增加 panel=notes 深链，与 notesPanelOpen 的入口信号双向协调；显式 URL、路由切换和快捷键优先级由纯 notesPanelTransition 定义并测试。笔记正文、绑定与固定标签仍保留原 owner，关闭笔记入口不删除内容/固定标签；隐藏笔记未出现在当前工作区时，“关闭其他标签”不动其全局固定标签。
- Owner 追加规则：所有工作区标签只留关闭按钮，无更多图标/移动菜单。鼠标拖拽，键盘 Alt+Shift+左右等价移动；右键保留关闭/关闭其他。旧 hover/focus 展开导致相邻标签移动 24px，六组真实浏览器复验现为 0px。
- 六组真实组件检查：会话笔记/侧问/文件切换只有一条标签栏，笔记草稿、固定标签在关闭入口再打开后保留；独立 Dock 同样通过排序/草稿/关闭不删正文。运行时行为测试确认会话页不输出第二个 Dock，但快捷键仍只触发一次。
- 全量 Web 301 文件 / 2717 测试通过；后追加共享标签仅关闭按钮、全局 runtime 宿主等 5 项定向测试通过。后续继续覆盖终端宿主、网页预览与整站最终回归；目前还未发布。


### 第七批：共享首屏品牌加载与预览标签统一

- index.html 预绘制和 React 共用 startupArtwork/startupLoader 样式；Vite 注入真实 tokens 和与 ThemeProvider 相同的主题读取，保留 splash 移除、超时与恢复机制。旧旋转卡片和独立 orbitLoader.css 删除，OrbitLoader API 保留为轻量兼容包装；普通路由用静态骨架。
- 首屏浏览器六组 1280/390/320 × 明暗验证：存储主题与系统主题相反仍正确，React 接管前后图形均 280×216，页面无横向溢出，内容就绪后 splash 移除，减少动态效果时连接动画停止。
- 设计预览 WorkspaceDock 同样复用 WorkspaceTabs，清理独立标签 CSS；只留常驻关闭、鼠标拖排，右键关闭其他不影响内容语义。真实共享组件六组 hover/focus 位移均 0px。
- Web 全量 304 文件 / 2725 测试通过，随后预览组件迁移后 tsc 退出 0。尚未推送、发布；跨组排序、终端宿主和其余整站迁移仍待完成。

### 第八批：团队、待办与帮助页视觉迁移

- 团队页修改原 teams.css 并删除重复外壳覆盖：20px 标题、13px 正文、32px 桌面控件，更紧凑的成员行/任务卡；coarse 输入 17px、控件至少 44px。任务状态、进度、成员会话链接、创建/调度/重试/归档逻辑均未改动。
- 待办原样式去掉强调色焦点外发光，桌面筛选与按钮缩至 32px，手机保留 44px/17px。来源切换、内置数据持久化、外部机器源、Agent 接入入口保留原组件和回调。
- 帮助页去掉大外框卡片，统一 20px 标题和 56px 说明行；修复旧标题引用未定义变量导致浏览器回落字号，清理已消除的 CSS 变量债务记录。说明分组、新建对话/终端、团队教程等入口未删减。
- css-probe 前后六组无溢出，团队桌面按钮 44→32px，手机 48→44px、输入 16→17px。真实 HelpScreen 六组验证三个分组展开及两个主要入口；真实 TeamWorkspace 使用示例数据渲染，六组验证五种任务状态/四栏及点击回调，保留全部任务结果与清理失败提示。示例不构成真实服务器业务验收。
- 相关 13 文件 / 89 测试、tsc 通过；帮助最小点击高度断言同步为 >=44px 并用变异验证。待办全路径浏览器、团队真实服务端联动及其余整站功能仍继续验收。未推送或发布。

### 第九批：终端文件栏与面板尺寸统一

- WebTerminalScreen 的独立“文件”标题/关闭栏替换为共享 WorkspaceTabs，单文件浏览入口保留关闭动作，仍使用真实 FsBrowser 的 cwd、刷新、排序、隐藏文件、全屏与文件阅读；关闭只收起文件区，不触发 PTY 停止。删除废弃 term-files-head/title CSS 和 X 引用。
- 会话与终端分栏断点统一为 1100px，窄屏全屏覆盖；默认宽度 36vw、至少 320px。已有宽度设置继续生效，CSS 额外按容器保留正文空间。终端 coarse 指针仍沿用覆盖模式，不触碰字号/行高、ResizeObserver/FitAddon 节流、键盘输入或通信链路。
- useFilesPanelWidth 在窗口 resize 时重新计算默认值，保留用户已拖拽设置；真实 Chromium 六组 hook 验证初始默认、窗口变为 1400 时 504px、拖拽至 430px、随后窗口变化保持 430px。前后 css-probe 验证 1099/900px 从分栏变全屏，320/390px 保持全屏，终端背景不变。
- files/terminal/sessionPanelState 40 文件 / 551 测试通过，tsc 通过，diff-check 通过。终端完整连接/恢复/输入、文件预览多标签与目录状态保留仍继续全站验收，不以本轮边栏迁移代表这些能力全部完成。未推送。

### 第十批：文件浏览位置恢复

- FsBrowser 支持可选 viewKey，文件会话和终端宿主显式传身份；身份组合包含机器与初始工作目录，变化时重建内部组件。普通目录选择器不参与恢复。
- 按身份保留最后目录、选中预览路径、隐藏文件开关；重新挂载仍走 fs-list/fs-read 获取当前内容，未新增正文缓存或修改 RPC/存储协议。内存视图缓存上限 100，避免无限增长；滚动偏移与文件多标签仍由后续统一处理。
- React 行为回归覆盖卸载/重开、恢复后 RPC 目标、预览关闭回目录、会话隔离、目录选择器隔离及隐藏开关；files 4 文件 / 41 测试、tsc 通过。本批无布局样式变化。

### 第十一批：公共预览与共享展示组件

- 公共 ProductWorkspacePreview 同步文件标签栏，移除对已删除 term-files-head 样式的依赖；关闭/重新打开、覆盖层键盘焦点恢复沿用原机制，目标选择器更新为共享关闭按钮。
- WorkspaceTabsView 抽为不依赖账户存储/语言 store 的纯展示组件；应用 WorkspaceTabs 适配真实语言，公共预览直接传入语言。初次复用暴露匿名路径间接读取 localStorage 的问题，拆分后公共 SSR 测试通过；不为预览引入同步数据依赖。
- 补齐实际使用的 18/24px 与中/慢动画 token，减少动态效果下全部归零；9px 图注统一 10px，旧 --mono、--dur-fast/--ease-out 迁到已有字体/动效 token。CSS undefined debt 归零。
- 相关 11 文件 / 51 测试、tsc、diff-check 通过；六组浏览器验证 Landing 预览关闭/重开与横向溢出，宽度 1280/390/320 × 明暗均无溢出。关闭接线源码断言经变异验证。
- 公共预览其他布局、Landing/docs 整体截图及 README 资产尚待完成，不以局部共享标签替代全部截图更新。

### 第十二批：公共侧栏与 README 截图更新

- ProductWorkspacePreview 补原有 Very Happy Logo，侧栏采用紧凑新建/搜索行和底部工具布局，运行概览移动到列表区域；删除按 nth-child 隐藏控件的旧预览 CSS，防止移动导航关闭入口随结构变化被隐藏。
- 公共预览与文档嵌入共用该组件；手机可编辑镜像输入使用 17px。保留匿名预览数据、文件选择/复制/返回、终端与结构化/概览切换，不新增真实 RPC。
- 真实浏览器 1280/390/320 × 明暗验证文件面板关闭/重开、页面无横向溢出；等待字体就绪后重新生成 docs/screenshots/workspace.png 与 file-handoff.png，后者在模拟传输完成后采集。README alt 明确为脱敏示例，不称为真实运行终端。
- 公共 7 文件 / 41 测试、tsc 与 diff-check 通过。图片和公共页面其余细节继续随全站最终检查收敛；尚未发布。

### 第十三批：更新通知与历史页

- ChangelogNotice 使用单层 canvas，多个版本以分隔线区分，去掉重复卡片外框与强调色焦点；手机关闭/确认/完整历史/CLI 复制按钮至少 44px，长内容仍在弹层内滚动，保留 Radix 模态语义与焦点管理。
- ChangelogScreen 改为紧凑时间列表，标题、正文、版本日期、CLI 版本和完整更新项均保留；不改版本选取、receipt、CLI 推荐或 SW 接管逻辑。
- css-probe 修前修后六组取证，真实浏览器六组验证弹窗边界、关闭确认、历史页长内容无横向溢出；相关 2 文件 / 11 测试通过，diff-check 通过。

## 用户更新通知草稿（整体验收后写入正式 release registry）

标题：工作台大升级：直接抄一手 Codex UI
摘要：更紧凑的会话与导航，更连贯的输入体验，保留 Very Happy 的微笑终端和多 Agent 特色。
已实现可陈述项：统一设计标准与明暗主题；移动端输入字号和登录居中；单行运行状态与输入/输出用量；侧栏入口与设置分类；文件/笔记等共享标签交互；品牌连接加载与更新提示。
正式内容须按最终功能验收结果修订，不在本地预览阶段宣称已发布，不提前分配版本号。

### 第十四批：笔记排版与废弃展示页清理

- 笔记正文改普通阅读字体，元信息保持等宽；桌面编辑操作至少 32px，coarse 至少 44px、输入 17px。手机固定按钮预留行内空间，避免遮挡标题。NotesScreen 和独立 NotesDock 的布局断点统一 1100px，保存和快捷键 owner 不变。
- 只读查询 main/config/路由/import 确认 App.tsx 早期 P0 展示页没有入口，App.css 只被该页引用；删除两文件共 401 行及它的专属旧主按钮测试项，保留生产按钮断言。此删除减少维护面，不声称降低已被 tree-shaking 排除的生产 bundle。
- notes/styles 7 文件 / 61 测试、tsc、diff-check 通过；css-probe 修前后测正文与控件；六组真实笔记组件浏览器验证排序、切换草稿与关闭不删除正文。笔记整页服务端联动仍纳入最终功能验收。

### 第十五批：整合回归与组件焦点规则清理

- 整合后 Web 全量 305 文件 / 2725 测试通过。继续走查发现组件局部 focus 规则会覆盖全局 quiet focus；修正会话选项、消息编辑、登录、附件、运行概览、公共交互等具体规则，不用额外全局 !important 覆盖层。
- 外侧 outline/强调色外发光改为内侧 1px 中性色焦点；终端控件使用自己的深色主题前景 token。没有改变非焦点的品牌装饰/实时信号动画，也没有改变终端字符度量。
- css-probe 六组修前后取证：会话选项 3px accent 外阴影变 inset，消息操作/登录 outline solid 变 none，保留可见内部焦点。修改后再次全量 Web 通过，源码行为逻辑未变。

### 第十六批：真实网页预览

- SessionWorkspacePanel 增加网页预览标签与同排入口，URL 状态新增 panel=web；旧 changes/files/browse/btw/agent/notes 和 sub 参数清理行为不变。仅 Web 本地视图状态，无 wire、数据库、server/CLI 协议变化，旧客户端遇到未知 panel 沿用忽略行为。
- BrowserPreview 使用用户输入的 HTTP(S) 地址，拒绝脚本/文件 URL、内嵌凭据与当前应用递归嵌入。iframe 受 sandbox 限制，不注入应用凭据、无 referrer，不代理请求或自动建立端口转发；远程服务需用户提供浏览器可达地址，空状态解释 localhost 指当前设备。
- 地址、刷新、新窗口打开和长时间加载回退可达；iframe load 只结束加载提示，不代表目标站允许嵌入，始终保留外部打开提示。标签隐藏保持 iframe，关闭后重开恢复地址而非保证外部网站运行状态，最多保存 100 个工作区地址。
- 六组真实浏览器使用独立本地测试站：拒绝非法地址、iframe 内容渲染、内部输入草稿在文件/网页切换后保留、外部 href 正确、手机 17px/无横向溢出。地址与 URL 状态测试、tsc 通过。
- 待全站整体验收继续确认入口密度、跨组排序、终端工具整合和最终包体；没有把网页预览等同于远端端口转发。

### 第十七批：跨类型工作区标签排序

- OrderedWorkspaceTabs 为文件、笔记和工具统一展示顺序，仅保存各标签 id，不迁移内容/权限/同步 owner；新标签追加，已关闭标签不显示，按工作区 identity 恢复顺序。原有分类导航保持固定位置。
- 鼠标与 Alt+Shift+左右可跨类型移动；同 owner 移动继续调用既有文件/笔记排序，跨 owner 不把错误 id 传给文件或笔记操作。父容器内容不随标签行重排卸载。
- 纯排序与 React 行为测试覆盖未知/重复 id、新标签、跨类型操作与身份恢复；5 文件 / 10 测试、tsc 通过。
- 六组真实浏览器验证文件↔网页跨类型顺序、桌面原生拖拽、工作区返回恢复、无横向溢出；原文件浏览器六组回归排序、内容滚动 200px、会话隔离、手机 44px 关闭目标通过。尚未发布。

### 第十八批：终端右栏统一

- TerminalWorkspacePanel 组合真实 FsBrowser、useNotesWorkspace、BrowserPreview，复用 OrderedWorkspaceTabs/WorkspacePane；终端的文件、笔记、网页处于同一右栏。按 tid/机器/cwd key 隔离，避免新终端继承旧 iframe/目录身份。
- WebTerminalScreen 协调 notesPanelOpen 与右栏显隐/当前工具；文件入口在笔记视图时切回文件，关闭右栏只关闭视图。保留原 ResizeObserver/FitAddon 拖拽节流、PTY 输入/恢复链，不新增终端停止操作。
- NotesDock 在 terminal/session 宿主只保留唯一快捷键与存储 bootstrap，不再输出第二个 aside。行为测试扩展到终端路由，确认 Cmd+J 仍只触发一次。
- 终端/笔记 39 文件 / 516 测试、tsc、diff-check 通过；六组真实组件浏览器验单标签栏/无重复 Dock、文件→网页→笔记切换草稿保留、手机 17px/无横向溢出。测试使用明确离线机器 fixture，不代表生产 PTY 和认证链最终验收。

### 第十九批：机器详情与终端选择页

- MachineScreen 和 TerminalPickerScreen 复用 SettingsPage/SettingsHeader，去除重复页面壳、终端样式标题栏及独立大留白。共用标题补齐 h1 margin 与长机器名/host 换行规则；新会话路径输入容器允许收缩。
- 保留机器认证、更新恢复、历史导入、重命名/删除和创建会话处理函数；终端新建仍带 fresh=1，打开已有终端仍为 attach-only。此批未修改 RPC 或 PTY 生命周期。
- tsc、diff-check、设置与机器工具 4 文件 / 18 测试通过；两页各六组真实组件浏览器（1280/390/320、明暗）无横向溢出，标题 20px；已查看手机机器详情截图。浏览器使用离线机器 fixture，不代表真实 daemon 操作已验收。

### 第二十批：整合门禁、更新通知与 SW 更新链

- 全量 Web 307 文件 / 2729 测试、Vite 生产构建通过。新增 sep10 中英文 release 数据，标题采用 Owner 指定文案；仅 Web 更新，不填 CLI 版本。claim sep10 通过；随后 changelog/语言 fallback/笔记快捷键 16 测试与 tsc 通过。
- 独立笔记 Dock 的 resize 监听断点修正为与实际双栏一致的 1100px，避免隐藏的旧断点分支。
- 本地两个真实生产构建 A/B，以版本标识区分 hashed entry；静态 server 保留 A 的旧 assets。Chromium 记录控制权变更次数 1→2、controller activated、实际入口从 index-CfciouFx-200.js 切至 index-BUOzTDUx-200uireview.js，新旧 CSS URL 均留存；刷新由现有更新机制完成，没有手动 reload 冒充接管。报告位于临时工作目录 sw-upgrade/report.json。
- 构建日志对比：主要入口 192.07kB/gzip 61.13kB 与 60.71kB/gzip 21.21kB 保持；AppRoot 2447.13→2437.92kB，公共 PwaInstallPrompt chunk 333.40→342.71kB。此为 chunk 层对比，完整入口依赖图审查见第二十一批。
- 更新迁移矩阵，清除已被后续批次解决的“待迁移”描述；未验证的真实存储、PTY、公共页面和其他包门禁继续明确待补。

### 第二十一批：真实构建依赖图与设计入口核对

- 将当前 HEAD 的已提交 Web 源码用 git archive 展开到任务临时目录，使用现有锁定依赖构建 baseline；当前 worktree 同样生成 Vite manifest。递归遍历 imports、按文件去重，纳入对应页面的显式动态入口；终端同时纳入 WebTerminalRoute 和实际 WebTerminalScreen，避免只计算路由壳。
- 下表为静态 JS+CSS closure 的逐文件 gzip 字节之和（十进制 KB），不包括按需字体/图片、后续用户操作触发的其他 lazy 功能或 API 响应；它是相同依赖口径的回归比较，不声称等于浏览器总下载量。匿名首页 closure 不包含 AppRoot；DEV 验证页面均不在生产 manifest。

| 加载范围 | 基线 gzip KB | 当前 gzip KB | 差值 KB |
|---|---:|---:|---:|
| 公共启动入口 | 99.98 | 100.02 | +0.04 |
| 匿名首页 | 243.40 | 246.23 | +2.83 |
| 工作台基础 | 1280.73 | 1280.85 | +0.12 |
| 会话页面 | 1351.88 | 1357.08 | +5.20 |
| 终端页面 | 1394.36 | 1398.63 | +4.27 |

- 没有新增第三方依赖；保留的开发预览用于 Owner 对照，不进入生产包。已有 AppRoot 大体积仍是独立优化面，不以本轮增量小声称整体包已小。原始 manifest、baseline SHA 与逐文件报告位于任务临时目录 bundle-review。
- 再核 AGENTS、CLAUDE、dev/design skill 入口和 Claude symlink 都指向同一设计 owner；修正设计契约配色示例中不存在的 --canvas/--ink/--muted 别名，改为实际 --bg-0/--text/--text-faint，避免未来按文档引用无效 token。入口审计文档标注为设计快照，当前迁移状态集中到本台账。

### 第二十二批：收起右栏保留内容

- SessionDetailScreen 和 WebTerminalScreen 通过 useRetainedWorkspace 保存当前身份最后打开的视图；收起时隐藏 aside、移除遮罩/拖拽条，不卸载文件/笔记/网页内容。会话身份改变释放旧内容；终端身份还包含 machine/cwd，路径变化仍重建。关闭具体标签继续卸载该标签，未改变关闭终端/PTY 语义。
- visible 独立传给面板：隐藏时文件计量刷新和侧问/笔记聚焦停用，WorkspacePane 在再次显示时恢复嵌套滚动。FsBrowser 的全屏 Escape 捕获受 active 控制，避免不可见窗口截获键盘。目录浏览的手动刷新保留。
- 新行为测试验首次未打开不挂载、收起重开保持同一 DOM 和输入、跨身份释放/隔离、隐藏全屏不消费 Escape；已有侧问接线断言更新并通过变异验证。全 Web 308 文件 / 2731 测试通过。
- 六组真实 TerminalWorkspacePanel 组件 + 实际 retain hook 的浏览器验证：关闭/打开保持原笔记 DOM、草稿不丢、单标签栏、无重复 Dock、无横向溢出，手机输入 17px。此处验证本地组件状态保留，不声称已验证远端 PTY 生命周期或跨整页导航后的网页内部状态恢复。

### 第二十三批：文档真实入口和跨包门禁

- 浏览器逐章取证发现中文 16 页中的 15 页存在重复 section id（纯中文标题都退化为 section-），目录无法区分目标。docSectionIds 保留现有英文锚点，支持 Unicode 标题和重复标题去重；docFragmentId 解码 URL hash，处理非法转义而不抛错。纯函数测试覆盖真实双语全部章节。
- DocsIndex 在 /docs→/docs/architecture 重定向下不可达。保留既有默认路径，把真实 ProductWorkspacePreview 放入 sessions 指南，KeyboardWorkflowProof/MobileContinuityProof 放入 keyboard/terminals 指南；删除不可达索引组件、分组映射、BookOpen import 和独占 CSS，移除该死组件的专属 reduced-motion 断言，保留其余公共动画断言。
- 16 章节 × 2 语言 × 3 屏宽（1280/390/320）× 2 主题共 192 页面浏览器通过：零页面横向溢出、零重复 id、零失效目录目标。桌面中英文目录实际点击后目标滚入可视区域；保存会话指南六种尺寸/主题的双语截图，查看中文手机长页。
- Wire build 和 9 文件 / 81 测试通过；CLI build + 232 文件 / 2079 测试通过，生成产物 --version 正常退出。Server tsc 通过。首次 Server 全量通过 641 项但跳过 Redis canary，随后在本地 OrbStack 启动独立临时 Redis 7.2.5（只绑定 loopback 随机端口、无持久化），canary 单独通过，再启用该环境进行全量复验。未访问生产 Redis。

第二十三批收尾：Server 启用隔离 Redis 后 98 文件 / 642 测试全部通过（无跳过）；最新 Web 309 文件 / 2733 测试、Vite build 通过，tsc 退出 0。测试结束停止本次 --rm Redis 容器，无测试服务留驻。

### 第二十四批：隔离真实服务验证

- 使用当前生产 Web 构建，由本地 standalone server 在 127.0.0.1:8201 服务；独立 DATA_DIR/PGLITE_DIR 位于任务临时目录，注册模式仅本地开放，无生产数据/凭据。新建真实测试账号并通过正常注册流程登录；不是在前端 store 填充业务 fixture。
- 浏览器 A 创建笔记、输入正文并等待真实 /v1/kv 成功响应；浏览器 B 使用注册后的初始认证状态（不含新笔记缓存）读取到完整正文。320/390 手机真实页面截图和页面溢出检查通过。
- A 创建内置待办，B 读到后标为完成；A 刷新进入已完成列表仍读到该记录。证明界面操作经过服务端持久化，而非只留本地乐观状态。
- A 在 settings/snippets 创建快捷指令，等待真实 /v1/account/settings 成功；B 打开编辑器读取相同内容。320px textarea 17px、页面溢出 0。未开启自动执行该指令。
- 无机器账号的七个新建入口逐个点击：普通/高级对话、指定目录终端、attach tmux、导入均显示对应配置弹窗和连接机器提示；快捷终端进入 /terminal，连接机器进入 /machine/connect。实际 Cmd+K 打开命令中心，Cmd+J 能开关唯一 NotesDock。此证据不等同于已有机器上的启动/attach 成功。
- 临时测试脚本、截图和持久化报告在 live-qa 目录；认证状态只留任务临时目录，不提交。当前本地服务保留用于后续机器/团队/终端联调。

### 第二十五批：真实配对与终端联调

- 测试 CLI 使用独立 HAPPY_HOME_DIR、空 shell HOME、最小环境与 createIsolatedTmux 私有 socket；通过本地标准 /terminal/connect 页面批准配对，验证成功后 URL 中配对 key 已清除。daemon 仅连接 127.0.0.1:8201，与当前生产 daemon/用户 tmux 隔离。
- 从真实侧栏新建 Web terminal；等待连接就绪后输入 printf 测试命令，确认独立输出行，刷新页面仍可恢复同一终端输出。Files 读取隔离目录实际 ui-preview.txt；Cmd+J 把笔记切入唯一右栏，无第二个 NotesDock。
- 390px coarse 通过实际键盘按钮聚焦，用浏览器原生文本插入事件发送每轮唯一命令，确认唯一输出及刷新恢复；文件入口在 More terminal actions 的 checkbox menu item 中，点击打开真实文件，再切换笔记。桌面/手机结果和截图位于 live-qa。
- 测试脚本最初直接向内部 helper 发送模拟逐键事件，不能代表手机软键盘输入，且旧固定标记可能误命中历史；正式手机验证已改为实际入口 + 文本插入 + 每轮唯一标记。此证据不覆盖原生 iOS 候选窗/软键盘几何，相关真机队列不取消。
- 本轮未改 PTY/输入协议。隔离本地 server、daemon 和私有 tmux 保留供后续团队/会话联调；停止标记由测试宿主处理，清理只作用于本次私有 socket。


### 第二十六批：团队真实设置与响应式状态修复

- 本地团队功能启用后，实际新建表单能列出机器、调用 fs-list 选择目录；测试通过 API 创建无 launch 的空草稿，不启动模型。UI 保存 Codex/model/maxParallel 后刷新读回一致；归档点击经过真实 actions 成功，刷新后保留归档状态。设置/计划表单/新建表单在 1280/390/320 × 明暗六组复验无页面横向溢出，coarse 输入 17px。主题使用实际 vh-theme-preference 初始化并核验背景 token，不以截图文件名作为主题证据。
- 发现旧 AppLayout 在桌面/手机切换或折叠侧栏时改变 Outlet 的 React 位置，导致团队设置回概览、未保存输入消失。抽出 AppShell 保持 routed view 和唯一 NotesDock 的节点位置，删除重复布局分支及无引用 app-detail--full 样式；移动首页仍显示会话列表，不额外挂载隐藏的首页内容。
- 同一真实表单修前四次尺寸切换全部丢失原 DOM，修后四次均保持同一输入和未提交值；侧栏折叠/展开同样通过。机制测试覆盖 expanded/collapsed/single/list、笔记宿主只挂载一次。css-probe 修前/后各 12 组验证内容高度 844px、页面溢出 0；真实手机终端命令、刷新恢复、文件和唯一笔记标签栏重新通过。
- 发现 CLI 已上报 teamLaunchVersion:1，但 Web MachineMetadataSchema 缺字段，解密解析时被 zod 剥离。补齐可选正整数字段，保留缺失/未来版本不启用的现有 UI 门控；测试经过实际 MachineEncryption 解析与缓存，覆盖缺失/1/2。真实隔离 daemon 在六组表单上均正确启用启动按钮。未改变服务器/CLI 协议、未启动模型。
- 本批 Web 全量 311 文件 / 2737 测试通过，生产构建和 tsc 通过。sep10 中英文补充状态保留与团队识别修复；设计 owner 增补断点切换不得重建页面的准则。团队任务执行、其余全站功能 review 继续按矩阵核验，未推送或发布。


### 第二十七批：公开页面补齐与触屏验收修正

- 注册页补齐手机无外层卡片的表面标准，去掉阴影/blur/边框，并将语言按钮定位在品牌区；触屏初次打开不聚焦用户名，与登录/邮箱初始输入一致。用户请求验证码后仍聚焦验证码，未改认证协议。注册、配对、公共空状态移除旧 CyberMark glow 参数，删除该参数的实现，统一静态 Logo。
- 发现验证环境中仅 hasTouch/isMobile 选项不能证明媒体查询生效：实际 maxTouchPoints=0、pointer:coarse=false；长页截图还会复位模拟。css-probe 改为页面建立后显式使用原生 CDP touch emulation，并在截图前/后验证 native coarse；手机仅截真实视口，滚动/溢出独立检查，桌面仍可全页。异常时 finally 关闭浏览器。dev skill 记录验证方式，不将窄窗口当触屏证据。
- 先前各批的宽度/主题/持久化结果仍有效，但未核验 native coarse 的旧截图不作为触屏专属验收。本批重新验证共享标签、真实 Sidebar（含 7 个新建入口/右键菜单/概览入口）、14 个设置路由，以及隔离服务上的终端命令/刷新/文件/笔记。手机原生 coarse=true，侧栏行/主导航 44px、设置输入 17px、页面无溢出；标签 hover/focus 位移 0。其余触屏专属项继续补验证，不能由这些局部结果推及全站。
- OTP 浏览器六组验证发送后验证码输入、错误提示、更换邮箱保留地址；请求由本地拦截器返回指定响应，不发送邮件、不声称已验证第三方身份服务。手机 native coarse=true、验证码 17px、页面无溢出。
- 注册页 css-probe 前后六组：手机外框/阴影/blur 清零，居中和可滚动空间保留；视口截图与像素取证留在 signup-before-native/signup-after-native。初始聚焦源码回归已通过变异验证。最新 Web 全量 311 文件 / 2738 测试、tsc、生产构建通过；本地服务已用最新完整 Web 构建重启，保留隔离账号和 daemon。

第二十七批公开页收尾：Landing/隐私/条款与登录（密码/邮箱）、注册（开放/邀请码/关闭/容量）共 9 场景 × 3 尺寸 × 2 主题 × 2 语言，108 页实际浏览器检查通过。48 个手机认证场景实际 native coarse=true，初始输入未自动聚焦、17px 字号、居中/溢出和底部法律链接可达性均通过。最终手机截图使用不改变 viewport 的 CDP 视口捕获，截图后仍为 coarse；桌面保存全页。原始报告 public-final-audit.json 及 public-final-* 截图留在任务临时目录；已查看中文暗色手机注册和 Landing 首屏。此前仅窄屏或长页截图重置模拟的产物不作为触屏截图交付。


第二十七批首屏回归修复：截图目检发现 Landing 首次打开直接跳到产品预览中部，之前的零横向溢出检查未覆盖初始纵向位置。根因是 WorkspaceTabsView 在挂载/激活时调用 scrollIntoView，滚动了所有祖先；改为只调整 tabstrip.scrollLeft。机制测试验证活动标签在横向溢出时可见，但宿主 scrollTop 不变。旧生产构建与当前代码的 3 尺寸 × 2 主题 × 2 语言对照：修前首屏 scrollY 为 1206.5–2814px，修后 12 组均为 0，hero 可见且页面无横向溢出。新首屏截图为 landing-first-after-*；早先 public-final-landing-* 仅作为故障截图，不作为最终 Landing 首屏交付。设计标准和 sep10 更新说明已同步。

第二十七批最终门禁：加入首页横向标签定位修复后，Web 全量 311 文件 / 2739 测试通过，tsc 退出 0，Vite 生产构建通过。尚未推送或发布。

### 第二十八批：标签统一交互与会话触屏复验

- Owner 再次确认所有内容标签只保留关闭按钮，移动直接拖拽。文件、笔记、会话右栏、终端右栏与预览已共用 WorkspaceTabsView；可移动标签保留 Alt+Shift+左右箭头等价操作，右键只有关闭相关动作，不增加 hover 图标或移动菜单。
- 本次重新运行实际浏览器标签检查，1280/390/320 × 明暗六组 hover/focus 的宽度与相邻位置变化均为 0；桌面鼠标拖动排序通过。文件切换后滚动位置保留、切换会话不串文件、返回恢复原标签、键盘关闭通过；手机 native coarse=true，关闭点击区 44px，页面无横向溢出。相关 3 文件 / 9 测试通过。原始脚本为任务临时目录 workspace-hover-coarse.mjs 与 workspace-files-native-final.mjs。
- 会话 native coarse 六组复验：状态槽固定高度且单行，流式增长贴底；主动上翻暂停跟随，回到最新恢复；详情展开不改变槽高度，后端身份弹层不溢出。输入框空稿运行时仅停止按钮，有稿运行时仅排队按钮；工具栏各组与主按钮中心齐平，上下文在框下。
- 队列真实组件的编辑、保存、取消、删除，以及历史消息原位编辑和取消通过；手机主输入/队列编辑/历史编辑均 17px，无横向溢出。本地 fixture 未向模型发送消息，不能作为新分支执行或真实 SDK 请求的证据。报告为 live-native.log、composer-native-report.json；队列/回退/消息分段相关 4 文件 / 48 测试通过。
- 只读核对 canonical PR：#317 与 #318 已合并且都是当前 HEAD 的祖先，原先会话 UI 改动已包含在基线；当前打开的 #314/#316 仅改其他文档路径。本次仍未推送、合并或发布，保留本地预览供 Owner 审阅。


### 第二十九批：侧栏管理操作与设置差异审查

- 真实 Sidebar fixture 在 1280/390/320 × 明暗六组验证项目分组、标签分组、不分组；桌面鼠标拖动改变顺序，手机通过行菜单上移/下移替代，settings.sidebarOrder 确实写入本地 owner。此 fixture 无认证，不将本地 settings 写入当作服务端同步证据。
- 会话右键进入重命名/标签编辑，添加标签 chip、取消后回列表；归档视图仍显示归档记录，状态视图保留等待权限记录。手机 native coarse=true，标签输入 17px，无页面横向溢出。第一次测试紧接拖动点击撞上既有 150ms 防误触窗口，等待拖动收尾后六组通过，不改产品防误触机制。任务临时脚本 sidebar-manage-final.mjs。
- 分组、手动排序、最近排序与列表投影的 5 文件 / 61 测试通过。设置三个生产 TSX 差异复核：只抽共享 Page/Header 与 SettingsWorkspace，保留全部 14 路由、数据读取和保存/认证回调；视觉验收仍以第 3/24/27 批为准，不重复执行真实账户身份变更。
- 本批未新增生产依赖、未推送发布。输入剩余入口、终端 attach/结束语义及全站最终 review 继续按矩阵推进。

### 第三十批：输入入口与残留焦点修正

- 实际 CSS 探针确认 EffortSlider 与 RelayBadge 的局部 focus-visible 仍覆盖全局标准，产生 2px 外侧 outline；两处改为中性内侧焦点反馈。六组修前/修后 computed style 证明 outline 2px → 0，手机命中高度保留 44px。终端选区/IME 的专属提示未改。
- 最高强度轨道使用既有 --effort-max-gradient；css-probe 像素取证和暗色手机截图目检确认彩色轨道可见。真实 AgentInput 模型弹层六组测试：End 选最高档显示彩条，Home 返回默认不显示最高样式，焦点无外框，320px 弹层在 x=12..308，未越屏。
- 在真实组件 fixture 中配置带 run:true 的快捷指令，六组均能从＋菜单进入 Shortcuts 并填入草稿，没有进入队列或自动发送。该标记仍只在终端有执行语义。初版测试手动 import 无版本 storage URL，读到与 Vite 热更新页面不同的实例；改用页面实际加载的模块 URL 后复验通过，不将测试注入问题当产品缺陷。
- EffortSlider/effortSelection/PresetsMenu/快捷键/预设数据共 5 文件 / 29 测试通过，Vite 生产构建通过，git diff --check 通过。原始脚本、修前后截图与构建日志在任务临时目录；隔离本地服务用新构建重启。仍未推送、合并或发布。


### 第三十一批：终端 attach 与结束语义真实验收

- 在本次隔离 daemon 的 createIsolatedTmux 私有 socket 内新建专用用户 tmux；通过真实侧栏新建菜单进入 Attach a tmux session，列表读取真实 tmux，点击接入后发送每轮唯一 printf 标记并核对输出，不启动模型。
- 桌面 1280px、手机 390px 暗色与 320px 亮色三条独立链路通过：关闭文件面板不影响源 tmux；关闭确认中取消不影响源 tmux；确认 Disconnect 后源 tmux 仍存活且可重新 attach；显式确认 Kill session 才使源 session id 从私有 socket 消失。每轮检查真实 tmux 存活状态，不仅检查弹窗或导航结果。
- 手机使用 native coarse 与实际键盘入口/文本插入，文件从 More terminal actions 进入；侧栏菜单可触达。所有被终止的源 tmux 都由本轮创建，未触及用户默认 socket。脚本 finally 仅清理自己的精确 source id；本地测试账号的关闭记录保留作证据。
- WebTerminalScreen 差异复核仅涉及工作区宿主/尺寸与笔记入口，原 PTY 字体、输入通信、重新连接与终止协议没有被替换。closedTerminals/newTerminalAttach 共 2 文件 / 30 测试通过。真实脚本为任务目录 live-qa/terminal-attach-final.mjs 与 terminal-attach-mobile.mjs。


第三十一批最终包体复核：本轮全部生产改动重新构建到独立临时目录并生成 manifest，沿用第二十一批同一 baseline 与静态依赖闭包口径（JS+CSS，逐文件 gzip 求和）。公共启动 +0.037KB，匿名首页 +2.130KB，工作台基础 -0.239KB，会话 +5.208KB，终端 +4.036KB。匿名首页未引入 AppRoot，生产 manifest 无 DEV harness，package.json/pnpm-lock.yaml 无改动；没有新增第三方依赖。完整报告覆盖更新为 bundle-review/report.json，构建日志 current-final.log。该对比不包括按需图片/字体和操作后动态资源，不宣称整体已有大入口足够小。


### 第三十二批：通知中心手机布局补齐

- 全站走查发现通知中心尚存两个旧规则：手机底栏铃铛 38px、面板操作 26px；桌面 .nc-panel[data-up=true] 的高优先级 top/bottom/max-height 覆盖手机全屏规则。真实 CSS 探针修前手机面板只有约 118px 高、停在视口下方，修后覆盖 0..844px 全视口，操作按钮和底栏铃铛 44px，桌面浮层保持原尺寸。
- 在样式 owner 补齐向上/向下定位的手机覆盖，并增加机制回归测试。删除关键 data-up 选择器的变异被测试捕获；未改通知源、跨设备已读或保留期限语义。
- 真实 NotificationBell 六组明暗/尺寸验证：手机 native coarse=true，面板不越界；标记全部已读清除未读样式，关闭后重开正常，点击通知跳转指定目标。测试通知仅注入开发 fixture 的设备本地 lane，不发送外部通知；目标为公开开发页，避免将未认证 fixture 的登录重定向误判为导航失败。
- Web 全量 312 文件 / 2740 测试通过；sep10 中英文同步手机通知全屏修复。修前/后 CSS 和截图取证为 notification-before/after，真实交互脚本 notification-final.mjs。尚未推送发布。

### 第三十三批：语音助手品牌与触屏收尾

- AssistantLogo 原先仍有未使用的占位图 API、待机光晕、额外圆框，以及文件尾部追加的活动光框/Logo 缩放。移除这些旧层和重复样式，唯一中心图形改为共享 CyberMark；保留独立聆听音量环、思考弧线和朗读波形，四态 Logo 大小与形状一致。AssistantScreen 只调整 Logo 调用，不改自动创建、语音输入、TTS、审批跳转或消息处理。
- 手机头栏按钮 34→44px，文字发送/重置 40→44px；输入已有全局 17px 保持。CSS 六组修前/后验证命中尺寸、字号和零横向溢出；采用真实 AssistantLogo SSR 输出在浏览器检查四态，目检发现后置活动光框后已清理并重新截图确认，未仅凭前半段 CSS 判断完成。
- 四态输出均为真实 0 0 32 32 CyberMark，待机无活动层、聆听环可见、思考弧线可见、朗读波形可见；减少动态效果规则保留。未连接麦克风、未触发真实模型/语音请求，此批证明视觉和既有状态接线，不冒充音频设备验收。
- 语音相关 13 文件 / 152 测试通过，tsc 退出 0，Vite 生产构建通过。设计 owner 增补语音四态规则；删除占位 SVG、glyph API 和旧动画，未新增依赖。最新闭包对比公共启动 +0.037KB、匿名首页 +2.129KB、工作台 -0.197KB、会话 +5.257KB、终端 +4.079KB gzip；语音助手自身为独立 lazy chunk，不包含在这五组口径里。
- 产物为 assistant-before/after、assistant-states 与对应日志，当前本地静态 8201 尚未重启接入本批构建；8094 开发预览已反映修改。剪贴板与剩余异常状态继续走查，未推送发布。


### 第三十四批：剪贴板历史触屏与数据操作

- 原历史面板顶部按钮 26px、展开和删除 24px；统一 coarse 下为 44px，编辑区复用 CopyButton 的本地容器也补到 44px，不扩大其他页面的代码复制按钮。保留桌面紧凑尺寸、手机全屏和全局 17px 编辑字号。
- CSS 修前/后六组验证按钮高度和零横向溢出。隔离账号真实 /settings/channels → Clipboard history 路径六组浏览器复验：编辑失焦后关闭重开保留文本、删除单条、取消清空保留记录、确认清空进入空状态；手机原生 coarse=true，面板恰好覆盖 0..844px，全部按钮 44px。测试只使用本轮注入的本地历史，不读取用户系统剪贴板。
- 浏览器在隔离 8201 的现有构建上加载当前 clipboard.css 验证真实组件，未把尚未重建的静态服务声称为最新生产包。首版脚本的 Clear all 同名按钮定位错误已修为确认弹窗范围，六组重新通过；没有改产品确认流程。clipboardHistory 19 项测试通过，git diff --check 通过。
- 脚本 live-qa/clipboard-final.mjs 与 clipboard-before/after 保留在任务临时目录；尚未推送发布。最后整合仍需重新构建/接管本地静态服务，并完成矩阵中输入、团队执行中状态、系统异常状态的最终覆盖审查。


### 第三十五批：团队状态与输入附件验收收敛

- 真实 TeamWorkspace 在 native coarse 六组明暗/尺寸复验 queued/running/submitted/done/cancelled 五种任务：四栏均保留，提交证据和 cleanup failed 提示直接可见；每个任务点击回调对应正确 id，页面无横向溢出。fixture 明确示例，不启动团队模型。TeamsScreen 本次无代码差异，TeamWorkspace 行为未替换；团队设置/归档的实际持久化已由第 26 批覆盖。
- 团队目录 6 文件 / 24 测试通过，覆盖任务状态呈现、进度、pending intent、schedule 草稿与 API 载荷等既有契约。此处的真实任务样式验证不等于执行新的自动调度任务；视觉改版没有修改调度器和任务状态模型。
- 实际 AgentInput 六组添加本项目 icon-192.png，确认图片加载后移除；附件不溢出，移除后原文字草稿保持。预设仍只插入、最高强度切换仍通过。附件能力/图片解析/历史附件 3 文件 / 20 测试通过；未把本地附件预览声称为上传或模型处理成功。
- 矩阵更新输入、团队与设置的完成证据，避免重复验证已保留的无差异业务实现。系统异常状态与最终整体 review/build 尚未完成；不据这些局部结果标记整个目标完成。脚本 teams-states-native.mjs、composer-attachments-final.mjs 与测试日志保留在任务临时目录，未推送发布。

### 第三十六批：统一标签规则与系统状态触屏收尾

- 再次核对所有工作区标签宿主共用 WorkspaceTabsView：只保留常驻关闭按钮，排序走拖动；Alt+Shift+方向键保留无鼠标替代，不添加移动图标或菜单项。右键仅提供关闭当前/其他标签，不改变标签宽度。文件、笔记、会话右栏、终端右栏与开发预览遵循同一规则。
- 真实 PermissionCard、SessionArchivedBanner、TerminalConnectionNotice 六组明暗/尺寸验证发现审批按钮约 29px，离线恢复按钮约 25px。各自 CSS owner 在 coarse 下补至 44px，桌面紧凑尺寸保持。CSS 修前/后取证权限六组和恢复三尺寸均无横向溢出；真实组件复验六组通过，终端重试与机器入口回调均可用。
- 没有修改审批 RPC、恢复状态机或终端连接流程；未发送真实审批、恢复或模型请求。标签、权限模式兼容、恢复状态机和终端状态相关 6 文件 / 28 测试通过。证据为 permission-before/after、restore-before/after、system-states-report.json；最终 Web 集成门禁正在执行。
- 本批最终集成结果：Web 312 文件 / 2740 测试全部通过，tsc 与 Vite 生产构建退出 0。标签浏览器复验 1280/390/320 × 明暗共六组，hover/focus 的宽度与位置变化均为 0。8094 开发预览可查看最新效果，未推送发布；8201 静态服务仍需重启以接管新构建。

### 第三十七批：本地交付审计

- 重新检查设计 owner、AGENTS/CLAUDE 和项目 skill：均指向同一契约，Claude skill 链接正确。原型 spec 与入口表明确标注历史快照，更新设计 owner 中过期的“尚未接入真实链路”描述；没有把本地实现标记成已上线。
- 复核实际改动中的 AppShell、Sidebar、SessionDetailScreen、FilesPanel/FsBrowser、NotesDock/useNotesWorkspace、SessionWorkspacePanel、WorkspaceTabsView/OrderedWorkspaceTabs、BrowserPreview、实时状态组件：保留原数据与权限 owner；稳定挂载、identity 隔离、隐藏面板键盘处理和菜单操作沿用各批回归证据。设置保存回调、真实笔记/待办/快捷指令持久化、终端私有 tmux 生命周期验证见前述对应批次。本轮未新增需要模型调用的业务语义。
- 最新生产构建接入隔离 8201：精确确认旧监听进程后仅停止该本地服务，重新启动同一数据目录，保留隔离 daemon。最终 36 个真实构建页面组合（首页、认证入口、设置、笔记、帮助、团队 × 三尺寸 × 明暗）运行无 pageerror、页面横向溢出为 0，手机 native coarse=true，均加载 hashed entry。证据为 live-qa/final-build-smoke.json；不声称验证了用户真机 iOS 行为。
- 最新 manifest 闭包复核：公共启动 +35B、匿名首页 +2139B、工作台 -136B、会话 +5337B、终端 +4137B（JS/CSS 分文件 gzip 求和）。无新依赖；匿名首页不导入 AppRoot；生产无 DEV harness。旧 App 展示组件与轨道 loading 样式已清理，README 两张截图经目检，Landing/docs 使用共享真实组件的脱敏预览。
- 最终 Web 312 文件 / 2740 测试、tsc、Vite 构建通过；未改动的 wire/CLI/server 门禁复核对应日志：81 / 2079 / 642 测试通过，构建与类型检查及 CLI 产物运行记录见第 23 批。后续正式 PR/发布仍须按 PROCESS 对最终 SHA 执行门禁与上线验收。
- 本地实现目标完成。真机专属 IME、软键盘和安全区沿用 V-080 等验证项；不是浏览器可验而留空的项目。按 Owner 最新“推送之前先看效果”要求，代码、设计文档、截图和 changelog 均留本地，未提交推送或发布。

### 发布批次

Owner 已确认预览并授权发布。重大界面更新使用品牌头部、更宽的桌面弹窗和突出标题；多条未读版本时仍突出最新重大更新，同时保留历史内容与原有已读机制。手机保留全宽底部面板、44px 操作区和可滚动正文。验证结果随发布验收记录追加。

容器发布门禁补充：首轮 CI 镜像构建发现 Dockerfile 的源码白名单遗漏新 build/startupSplash.ts，本地 Vite 成功不能覆盖此路径。仅增加该脚本的精确 COPY，不扩成整包复制；重新执行完整容器门禁后才能合并。生产尚未切换。


### 生产发布验收（2026-09-10）

- Owner 确认预览并授权发布。PR #320 必需检查（四包、完整容器、密钥检查）全绿，经 land-pr.sh 合并为 `6d337987d65c14f8bf8501263f797d6b88881f60`；该精确 main SHA 的 Quality Gates run 34393412886 成功。首轮容器白名单遗漏已在合并前修复并完整复验，未绕过失败门禁。
- 发布 run [34393860441](https://github.com/Mereithhh/very-happy/actions/runs/34393860441) 成功，target=all / rollout=switch，仅 server/Web 完整不可变镜像，不更新 CLI 或 daemon。实际生产 vh-sg active blue:3101，release generation 107，镜像 `ghcr.io/mereithhh/very-happy-server@sha256:a76980d7e6c6c09eb68359d3babb2ab987dac6075d31c5fed763fc2b7e536320`。
- 保留回滚 green:3102，版本 `a5b01fc90f60fb3bf4daeab39536e112559d54a6`，镜像 digest `sha256:173d5ac5c6e60bdc0af36b10969a21a892330675849d32c78410946d66811d40`。遵循 operations 的阶段式回退，不删除可能持有连接的实例。
- `/health` 为 ok。check-shipped 遍历 52 个实际资源，SHA 与目标一致，`.wn-brand`、`workspace-tab-close`、`2026-09-10-compact-workspace` 全部命中，无 HTML fallback 或缺项。
- 生产 `/welcome`、`/login`、`/changelog` × 1280/390/320 × 明暗共 18 组真实 Chromium 检查通过，手机 native coarse=true、页面横向溢出 0、无 pageerror；记录实际 entry/CSS/controller，未以刷新返回冒充 SW 接管。更新接管机制的两个真实构建验证见前述批次，真机 IME/键盘仍在 V-080。
- 用户前台检测到新版本后可点击更新按钮；后台遵循既有自动更新策略。新版本 ChangelogNotice 突出本次品牌头部与重大更新标题，确认后写入原已读凭证；多版本未读仍保留完整列表。未向用户发送额外邮件或通知渠道消息。

## B-444：字号与密度校准（2026-09-10）

Owner 再次对照 Codex 截图确认左右主要文字应协调，并指定手机输入 16px。正式回复
仍为 16px/1.7，早期工作台原型则为 14px/1.6；本批修正正式实现并同步原型与设计契约。
主要导航、会话名、桌面输入和双方消息采用 14px；触屏/窄屏双方消息 15px，输入 16px。
正文段落 12px、列表项 4px；共享 Markdown 的长文默认不受影响。输入默认高度约 50px，
保留随内容增长与展开上限。两类消息共享字号/行高 token，长消息折叠高度跟随行高。

走查范围：侧栏、对话/原位编辑/队列、工具记录、文件树/预览/浏览器地址栏、设置、
团队、待办、笔记、登录与弹层输入。工具与文件区域保留 11–13px 辅助字号，设置与
团队低频控件保留原层级；宣传页标题不缩小，终端字体/行高/列数与触屏 44px 命中区不变。
移除可编辑控件遗留的 17px 局部覆盖；手机 iOS 原生聚焦行为记录 V-152，不以桌面
Chromium 的 scale 结果冒充真机验收。

回归验证：字号契约、移动输入与紧凑输入高度测试；五处源码变异均能令测试失败。
CSS probe 修前修后覆盖明暗主题与 1280/860/390/320px；真实 ChatList/AgentInput
验证字体、单行状态、自动跟随、上翻保持、展开详情、减少动态效果；侧栏与设计页验证
主要标题 14px、手机输入 16px、无横向溢出。


### 侧栏视觉协调（B-445，2026-09-10）

- 正式侧栏与正文只保留拖拽区右缘的一条 1px 线，保留 6px 命中区；hover / dragging 使用中性边界色，不借用 live 色。底部工具区去掉横线，用留白与同底色分区。
- 主导航、普通会话行、设置的图标左边界统一 16px，文字起点 42px；项目/团队的层级缩进保持独立。标签保留色彩但去掉边线，快捷键徽标使用中性色。
- 排序说明放入现有展示菜单，可勾选展开 / 收起；分组限制与切换为不分组按钮仍在说明内，列表拖拽、菜单移动与快捷键不改。
- 验收：真实 Sidebar 在桌面、320/390px coarse 双主题检查菜单、排序说明、搜索、快捷键与溢出；真实 CSS 的前后 probe 检查边界、对齐与像素。没有新增真机专属行为。
