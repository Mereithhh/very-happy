export type PublicDocTranslation = {
  label: string;
  summary: string;
  sections: Array<{
    heading: string;
    blocks: Array<string | string[] | null>;
  }>;
};

export const PUBLIC_DOCS_ZH_HANS: Record<string, PublicDocTranslation> = {
  quickstart: {
    label: '快速开始', summary: '连接一台机器，然后把 Web/PWA 作为日常工作区。',
    sections: [
      { heading: '推荐工作方式', blocks: ['把 Web 或可安装 PWA 作为每天使用的产品界面。CLI 是机器侧配套工具：安装一次、配对机器、启动后台 daemon；只有诊断、自动化或明确需要本地启动时才回到 CLI。', 'Web 仍需要已连接的 daemon 才能访问本地进程和文件。“Web 优先”表示浏览器是默认界面，不表示机器侧 CLI 可以省略。'] },
      { heading: '最快路径：一条命令', blocks: ['在 macOS 或 Linux 上，Cloud 引导脚本会安装一个精确的已发布 CLI 版本、执行本地诊断、打开正常的一次性 Web 授权，然后启动脱离终端的机器 daemon。', null, '命令会先把完整脚本下载到随机临时文件，执行后删除。运行远程代码前请检查版本控制中的 install.sh；托管内容可能随 Web 发布变化。脚本不会调用 sudo、安装 tmux、写入 provider 凭据或启用可选 Claude hooks。可用 --dry-run 离线预览且不产生变更。之后如添加结构化 Claude 凭据，请重启 daemon 以继承新环境。Windows、自托管端点或希望显式控制的用户应使用下方手动步骤。'] },
      { heading: '1. 选择中继', blocks: ['最短路径是使用 veryhappy.dev 的 Very Happy Cloud，也可以先部署自己的中继。浏览器账户和所有已连接 CLI 必须使用同一个中继。', 'Very Happy Cloud 上手最快。自托管让你掌控运营方、访问策略、存储、备份与升级。为敏感工作选择部署方式前，请阅读“安全与隐私”。'] },
      { heading: '2. 检查机器', blocks: [['必需：Node.js 20.x 中的 20.19+、22.x 中的 22.13+，或 24+，并带 npm。', '结构化 Claude：CLI 内置 Agent SDK；请为 daemon 用户配置 Claude provider 凭据。原生 Claude 终端/镜像、Codex、Gemini、OpenCode 与 OpenClaw 需要各自的本地命令或 gateway。', '推荐：tmux 可让 Web 终端在浏览器断开后继续运行；缺少 tmux 时会降级为不持久的直接 shell。', '可选 Claude 终端镜像：需要 tmux 3.2+。正常的结构化 Claude 路径不需要 tmux 或 hooks。'], null, 'CLI 在支持的平台内置 ripgrep 与 difftastic。provider 凭据默认保留在 Agent 本地。只有显式执行 very-happy connect 时，选中的 OpenAI、Anthropic 或 Gemini OAuth 凭据才会存入你选择的部署，供 Web 启动的集成使用；目前主要用于 Gemini 路径。'] },
      { heading: '3. 配置 Claude 凭据', blocks: ['Very Happy 内置 Claude Agent SDK，但不包含 Claude 用量或账户。结构化会话需要在运行 daemon 的同一 OS 用户与启动环境中配置 ANTHROPIC_API_KEY，或受支持的 Bedrock、Vertex AI、Foundry 环境。', null, 'Doctor 只报告 daemon 捕获到的凭据来源类别，绝不打印凭据值。服务管理器需要在自己的 secret store 或私有环境文件中配置凭据。修改后请重启 daemon；在无关 shell 中 export 不会更新已经运行的服务。正常路径让 provider 凭据留在本机；very-happy connect 是另一条上传到中继的显式流程，此处不需要。'] },
      { heading: '4. 验证邮箱并登录', blocks: ['默认推荐使用邮箱验证码。邮箱已存在时直接登录；新邮箱在注册策略允许时会自动创建账户。中继启用时也可以使用 Google，或兼容的用户名密码。注册可能关闭、仅限邀请或达到容量上限；暂停注册时既有账户仍可登录。', '在手机或平板上，站点会主动提供“添加到主屏幕”。Android/Chromium 点击安装后打开原生安装对话框；iPhone/iPad 或不支持该事件的浏览器会显示分享/浏览器菜单步骤。不安装也能继续使用同一套响应式界面。'] },
      { heading: '5. 连接机器', blocks: [null, 'CLI 会打开一次性浏览器授权页。只有当你刚刚在眼前这台机器上启动了命令时才确认。公共或非 loopback 部署应使用 HTTPS。'] },
      { heading: '6. 启动机器 daemon', blocks: [null, '这会启动脱离终端的后台进程。daemon 在线时，机器会出现在 Web 中。除非服务管理器自动启动，否则重启机器后需要再次运行。用 very-happy daemon status 查看 daemon 启动时捕获的非敏感 Claude 凭据来源。持久 Web 终端需要 tmux；可选 Claude 镜像需要 tmux 3.2+。没有 tmux 时，Web 终端使用不持久的直接 shell。'] },
      { heading: '7. 开始工作', blocks: ['回到 Web，在已连接机器上选择“新建会话”。这是推荐的日常路径。你可以通过内置 Agent SDK 启动结构化 Claude，也可以打开 Web 终端运行真实 shell 或普通 xterm-256color 文本 TUI，例如 vim、lazygit、ssh 或数据库控制台。原始终端路径不绑定某一种编程 Agent。', 'Web 终端是 TERM=xterm-256color 的 xterm.js 界面。大多数常见文本 TUI 都能使用，但 sixel、Kitty graphics 等终端专属图形或扩展不在兼容承诺内。', null, '本地 CLI 模式需要对应命令或 gateway。beta Agent Client Protocol 后端包含 Gemini、OpenCode 预设与通用 runner；自定义命令必须通过 stdio 暴露兼容 ACP 端点。OpenClaw 使用自己的本地 gateway 协议，不是 ACP。机器持续离线时请运行 very-happy daemon status。', '在 Web 终端中粘贴剪贴板图片/文件或拖入文件，即可交给选中的机器。单文件上限 8 MB，暂存于 ~/.happy/uploads/terminal/，客户端只会把按 daemon 默认 shell 正确引用的路径放到光标处，不会按 Enter。更大文件与原生 Windows 路径插入需要当前版本 daemon。'] },
      { heading: '8. 了解工作区', blocks: ['第一台机器连接后，首页会变成一份可随时回看的导览。分别创建一次结构化 AI 对话和真实 Web 终端，再打开设置，了解外观与语言、Agent 默认值和 review 模式、快捷指令与终端行为、通知、机器、通道和剪贴板传递。', ['Command/Ctrl K 搜索操作、对话和终端；Command/Ctrl . 打开快捷指令；Command/Ctrl J 切换临时笔记。', '从对话或终端顶部打开“文件”；结构化 Agent 工具产生的文件路径可直接点击预览。', 'Todo 读取机器上已配置的 provider，并可按列表或优先级分组。', '安装可选 Claude 终端 hooks 后，在 Web 终端中启动的 Claude 可在原生 TUI 与结构化文本记录间切换；该能力仅适用于 Claude。', '粘贴剪贴板图片/文件或拖入文件，可上传到当前机器并插入安全引用的路径，不会自动执行。', '可要求托管 Agent 使用 copy_to_clipboard 把文本发送到浏览器。“设置 → 通道”控制自动复制与剪贴板历史。'], '本导览中的每条键盘路径在侧边栏或会话顶部都有对应的触控入口。完整的“键盘与触控”指南会说明浏览器保留快捷键的边界。'] },
      { heading: '可选：镜像手动启动的 Claude 终端', blocks: [null, 'SDK 驱动的 Claude 对话无需此功能。安装命令只会把 Very Happy 的 SessionStart/SessionEnd 项合并到 ~/.claude/settings.json（或 $CLAUDE_CONFIG_DIR/settings.json），不会移除其他 hooks。daemon 运行时，它只镜像在 Very Happy Web 终端内手动启动的 Claude。'] },
    ],
  },
  keyboard: {
    label: '键盘与触控', summary: '在工作间移动、执行命令，同时保留终端原生快捷键。',
    sections: [
      { heading: '命令面板', blocks: ['macOS 按 Command K，Windows/Linux 按 Ctrl K，可搜索操作、活跃聊天与终端。用上下方向键移动、Enter 执行、Escape 关闭。会话 #tag 过滤与侧栏搜索使用同一语法。', ['创建聊天或终端，也可以在指定目录中创建终端。', '按名称、机器、路径或会话标签跳转到聊天或终端。', '打开语音助手、剪贴板历史、笔记、Todo 或设置。', '触屏设备可点侧栏搜索按钮，在没有硬件键盘时打开同一命令面板。'], '命令面板不会发送终端输入。macOS 上应用级快捷键使用 Command，因此 Ctrl K、Ctrl J、Ctrl N、Ctrl R 仍保留给 readline 和真实 Agent TUI。'] },
      { heading: '高价值快捷键', blocks: [['Command/Ctrl 1–9：侧栏已挂载时切换到对应的可见行。', 'Command/Ctrl .：在当前聊天或终端打开已保存快捷指令；菜单打开时按 1–9 选择预设。', 'Command/Ctrl J：在工作区路由切换笔记面板。', 'Command/Ctrl R：当前聊天或终端的侧栏行可见时重命名，否则浏览器继续执行刷新。', 'macOS 的 Command [，或编辑框外的 Alt + 左方向键：返回。', '已安装的 macOS PWA 中按 Command N，或 Windows/Linux 在编辑框和终端输入之外按 Ctrl N：新建终端。Alt N 是普通浏览器标签页中的后备键。', '已安装的 macOS PWA 中按 Command W：通过已配置确认保护关闭当前聊天/终端。Alt W 是跨平台后备键；Ctrl W 仍由浏览器/窗口处理。'], '普通标签页中 Command/Ctrl N 与 Command/Ctrl W 被浏览器保留，页面无法可靠拦截。Very Happy 不会伪装支持：安装 PWA 获取更接近原生的快捷键，或使用文档中的 Alt 后备键。没有可关闭会话的路由会把关闭快捷键交还浏览器。'] },
      { heading: '触控与移动端', blocks: ['所有键盘流程都有可见触控路径：侧栏搜索打开命令面板，页头控件打开文件、笔记与结构化/终端切换，“新建”按钮创建会话，返回按钮与边缘滑动完成导航。移动终端也提供触控优先的输入控件，不要求硬件键盘。', '安装为 PWA 会移除浏览器 chrome，并在操作系统允许时获得浏览器通常保留的应用快捷键。安装不是必需条件；普通标签页中的响应式 Web UI 仍可完整使用。'] },
    ],
  },
  cli: {
    label: 'CLI 与 daemon', summary: '连接并运行 Web/PWA 工作区的机器侧配套组件。',
    sections: [
      { heading: '产品中的角色', blocks: ['Web/PWA 是推荐的日常界面。CLI 用于配对机器、启动和诊断后台 daemon、在你明确需要时启动本地 Agent 模式，以及提供自动化命令。它不是第二个必须长期停留的 UI。'] },
      { heading: '安装', blocks: ['Very Happy 需要 Node.js 20.x 中的 20.19+、22.x 中的 22.13+，或 24+，并带 npm。持久 Web 终端还需要 tmux；可选 Claude 镜像要求 3.2+。Windows 或其他没有 tmux 的环境会使用不持久的直接 shell。请全局安装已发布 CLI：', null, 'Doctor 会报告当前中继与授权页面、Node 版本、tmux 能力、内置 Claude SDK、可见的外部 Agent 命令、认证和 daemon 状态。缺少 tmux 是明确的降级模式，不是认证失败。'] },
      { heading: '认证', blocks: [null, '命令会打印短期有效的授权 URL。只有当你亲自在可信机器上启动了该命令时才批准。'] },
      { heading: '运行', blocks: [null, '远程操作要求 daemon 在线。Web 创建的结构化 Claude 使用内置 Agent SDK 和 provider 凭据。请安装你准备运行的每条外部/本地 Agent 路径，并确保 daemon 用户能解析其命令或 gateway。Codex 有专用模式，OpenClaw 使用自己的 gateway，beta ACP 覆盖 Gemini、OpenCode 与兼容自定义命令。'] },
      { heading: '可选 Claude 终端镜像', blocks: [null, '第一条命令只向 ~/.claude/settings.json 或 $CLAUDE_CONFIG_DIR/settings.json 添加 Very Happy SessionStart/SessionEnd 项。daemon 运行时，它让 Very Happy Web 终端中手动启动的 Claude 进程拥有结构化镜像。--remove 只移除这些条目。正常 SDK Claude 会话不需要 hooks。'] },
    ],
  },
  cloud: {
    label: 'Very Happy Cloud', summary: '了解托管公共中继、注册策略与运维边界。',
    sections: [
      { heading: 'Cloud 提供什么', blocks: ['veryhappy.dev 托管 Web 客户端、账户服务、同步存储与中继，无需自建服务器即可体验 Very Happy。', ['公共注册可以开放、仅限邀请、暂停或受全局容量限制。', '社区服务不承诺在线率或数据持久性 SLA。', '运营方能够访问中继保存的内容和账户恢复材料。']] },
      { heading: '何时应该自托管', blocks: ['需要自己的访问策略、保留控制、网络边界或运营方信任模型时，请自托管。自托管只是把信任转移给你的运营方，不会让协议变成端到端加密。'] },
    ],
  },
  'self-hosting': {
    label: '自托管', summary: '运行自己控制的中继，并让 Web 客户端和 CLI 指向它。',
    sections: [
      { heading: '部署形态', blocks: ['在 HTTPS 后部署 happy-server 并持久化 /data。服务启动前，Docker 镜像默认迁移内置 PGlite，或显式配置的外部 Postgres。暴露服务前请设置明确的注册策略与账户上限。', null, '先用 bootstrap code 注册第一个运营账户，然后以 SIGNUP_MODE=closed 且不带 SIGNUP_INVITE_CODES 重新创建容器。普通 docker restart 会保留旧环境。邀请码不会自动消费。完成 HTTPS 与代理信任配置前，只在 loopback 上监听。', '打开完整部署与环境指南 ↗'] },
      { heading: 'Loopback 评估', blocks: ['本地评估请使用上面的 Docker 形态并绑定 127.0.0.1。不要安装上游维护的 happy-server-self-host 包：它提供的是另一个产品构建。very-happy-server workspace 包刻意保持 private，因为其 Prisma 构建工具不是已批准的公共生产依赖面。'] },
      { heading: '连接 CLI', blocks: [null, '每个中继使用独立 HAPPY_HOME_DIR，并确保启动 daemon 的环境同时包含三个变量。令牌和机器 ID 都只属于对应中继；只有在明确替换现有 home 时才使用 auth login --force。生产环境请使用 HTTPS。'] },
      { heading: '生产运维', blocks: ['备份持久卷、固定版本、检查服务健康，并在升级前演练回滚。只配置你实际运营的登录 provider；在真实邮箱验证码或 Google 登录成功前，绝不要关闭密码登录。'] },
    ],
  },
  configuration: {
    label: '配置', summary: '保持 Web、中继与 daemon 的端点和策略一致。',
    sections: [
      { heading: '客户端端点', blocks: [['Cloud 用户不需要端点变量；两个客户端 URL 默认都是 https://veryhappy.dev。', 'HAPPY_SERVER_URL 选择 CLI 使用的 API 与 socket 中继。', 'HAPPY_WEBAPP_URL 选择机器授权时打开的浏览器 origin。', 'HAPPY_HOME_DIR 选择机器本地凭据、设置、日志与 daemon 状态。', 'VH_SERVER_URL 选择 Web V2 的 Vite 开发代理目标。'], null, 'daemon 在启动时继承环境。默认情况下，provider 凭据与 Agent 命令必须对 daemon OS 用户及其 PATH 可见。显式运行 very-happy connect 是例外：它会把选中的 OAuth 凭据上传到可信中继。', 'OpenClaw 会读取 OPENCLAW_GATEWAY_URL 与 OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD，也可以查询已配置的本地 openclaw 命令。配对后的设备身份以私有权限保存在机器的 $HAPPY_HOME_DIR/openclaw 下。'] },
      { heading: 'Claude 凭据', blocks: ['结构化 Claude 使用内置 Agent SDK，但仍需要 provider 账户。推荐在 daemon 启动环境中配置 ANTHROPIC_API_KEY、Amazon Bedrock、Google Vertex AI 或 Microsoft Foundry。Very Happy 不代理 Claude.ai 登录。', ['Claude API：ANTHROPIC_API_KEY。', 'Bedrock：标准 AWS 凭据，加 CLAUDE_CODE_USE_BEDROCK=true。', 'Vertex AI：标准 Google Cloud 凭据，加 CLAUDE_CODE_USE_VERTEX=true。', 'Foundry：标准 Azure 凭据，加 CLAUDE_CODE_USE_FOUNDRY=true。', '可能检测到现有 apiKeyHelper、CLAUDE_CODE_OAUTH_TOKEN 或本地 Claude 凭据文件；仍须遵守 Anthropic 当前政策。不会检查 OS keychain 凭据。'], null, 'Doctor 只打印来源类别。如果当前进程能看到来源而 daemon status 看不到，请修复服务管理器 secret/环境并重启。如果来源存在但会话被拒绝，请以 daemon OS 用户身份检查 provider 账户、区域、模型权限与计费。', '打开 provider 与服务管理器详情 ↗'] },
      { heading: '账户策略', blocks: ['服务端控制邮箱验证码、密码与 Google 注册、邀请要求、全局账户容量和限流。SIGNUP_MODE 默认 closed；开放注册必须显式配置。公共中继的 SIGNUP_MAX_ACCOUNTS 应设置为较小且经过审核的容量。', ['HANDY_MASTER_SECRET 保护服务端保存的账户恢复材料与服务 secret。', 'SIGNUP_MODE / SIGNUP_MAX_ACCOUNTS / SIGNUP_INVITE_CODES 控制注册。', '机器、会话、消息、附件、artifact 与 KV 限制约束持久化数据。', 'SOCKET_MAX_PAYLOAD_BYTES、RPC 限制与 TERMINAL_RELAY_* token bucket 约束实时中继流量。']] },
      { heading: '运维与指标', blocks: ['只有 METRICS_ENABLED=true 时才启用指标，默认绑定 127.0.0.1。仅可为受保护的抓取网络设置 METRICS_HOST；不要把 9090 端口暴露到互联网。完整配置参考还包含数据库、S3、Redis、代理信任和 Google OAuth 设置。', '打开所有服务端与 CLI 变量 ↗'] },
      { heading: 'Secret', blocks: ['主 secret、OAuth secret、推送凭据与存储凭据不得进入 Git。每个环境使用不同值，并限制对备份与服务端日志的访问。'] },
    ],
  },
  architecture: {
    label: '架构与数据流', summary: '了解身份、状态、中继流量与执行分别由哪个组件负责。',
    sections: [
      { heading: '组件', blocks: ['账号级机器集群 · 控制/数据平面 · 一个 Web 工作区', '浏览器是账户下所有已连接机器的统一指挥界面。侧栏与看板聚合这些机器上的会话和注意力状态；创建工作时要明确选择机器与 Agent。控制/数据服务负责账户认证与同步状态；无数据库的区域 Relay 承载对延迟敏感的机器 RPC 与终端流量。每个 daemon 并行探测候选节点并锚定实测 RTT 最低的健康 Relay，浏览器随后跟随同一机器分配。'] },
      { heading: '区域 Relay 选择', blocks: ['中央持久状态 · 实测 Relay RTT · 短期 Token · 兼容回退', ['运营方配置候选 Relay origin；客户端不能注入任意 Relay URL。', 'daemon 并行探测健康端点，以实测 RTT 最低者为首选，RTT 相同时按配置顺序稳定选择。', '控制服务验证机器归属，并签发短期、机器级 Relay token；Relay 不接收数据库凭据或账户 bearer token。', '终端标题栏显示当前 Relay 和浏览器到 Relay 的 RTT。发现或连接失败时自动回退兼容的控制服务链路。'], '这是以机器为锚点的路由，不是全球 SLA 承诺。自托管运营方决定实际部署哪些区域。浏览器到 daemon 的 WebRTC 直连是后续路径，区域 Relay 将继续作为 fallback。'] },
      { heading: '会话流程', blocks: ['机器级命令 · Runner 归一化 · 持久状态收敛', ['用户向控制/数据服务认证浏览器。', '一次性授权把 CLI 身份连接到同一账户。', '持久请求和更新保留在控制链路；机器 RPC 与终端字节优先走已分配的区域 Relay。', 'daemon 调用本地终端或 Agent 进程，并把结果流式传回。']] },
      { heading: '结构化与原生终端路径', blocks: ['两条执行路径 · 一个工作区 · 两种真实来源', '上游 Happy 的核心 Claude 流程是 SDK 驱动的结构化会话。Very Happy 保留该路径；安装 tmux 后，还能传输用户机器上真实进程的 TTY。终端传输与 Agent 无关：shell、vim、lazygit、ssh、数据库控制台、普通 xterm-256color 文本 TUI 或 Agent CLI 都使用同一字节流。daemon 通过可信中继传输 pane 输出与输入，xterm 在浏览器中渲染终端；它不是截图，也不是浏览器重写的 TUI。', ['SDK 路径：Claude Agent SDK 事件转为结构化消息、工具、diff、权限、用量与恢复状态。', '终端路径：tmux 让真实 TTY/TUI 在浏览器断开后继续运行，并支持重连、scrollback、搜索、文件与移动输入。', '后备路径：没有 tmux 时，Web 终端是不持久的直接 shell；可选 Claude 镜像需要 tmux 3.2+。', '两条路径不保证等价：终端进程不会自动获得 Claude 风格的结构化消息或 Agent 控件。']] },
      { heading: 'Agent 适配器', blocks: ['Claude Code 与 Codex 有专用集成路径，OpenClaw 使用自己的本地 gateway 适配器。beta Gemini/OpenCode 适配器通过官方 SDK 在本地 stdio 上使用 Agent Client Protocol；它不同于同样简称 ACP 的旧 Agent Communication Protocol。自定义 ACP 命令必须实现兼容的 Agent Client Protocol 端点。'] },
      { heading: '可选终端镜像', blocks: ['SDK Claude 会话直接发送结构化事件。在 Very Happy Web 终端中手动启动的 Claude 不同：可选的 very-happy install-terminal-hooks 会加入作用域明确的 SessionStart/SessionEnd 项，使 daemon 能把进程绑定到结构化影子会话并返回同一个 TUI。--remove 只回滚这些条目。该镜像仅适用于 Claude。'] },
      { heading: '兼容性', blocks: ['协议变更会让旧客户端忽略新字段。变更包含兼容矩阵时，请按发布说明部署 server、web 与 CLI。'] },
    ],
  },
  integrations: {
    label: '集成与自动化', summary: '连接 IM、调度器与任务系统，同时避免把私有策略写进核心。',
    sections: [
      { heading: '交接到 Web 工作区的 MCP', blocks: ['基础托管 Claude 会话提供 change_title、copy_to_clipboard、open_preview 与 report_progress。托管 Codex、Gemini 与 ACP bridge 提供 change_title、copy_to_clipboard 与 open_preview。这些交接让 Agent 把本地工作变成可见 Web 状态，而不只是再打印一行终端文本。', ['仅 Assistant/meta-agent 变体提供：会话列表/读取/发送/派生/停止/归档、终端列表/读取/发送，以及 memory_update 和 journal_append。', '这些 Assistant 专属工具可以修改本地会话、终端、记忆与日志。应把 Assistant 及其 prompt/tool 权限视为高权限机器控制面。'], null, '这个 --scope user 注册会让该 OS 用户的每个 Claude 会话都获得 copy_to_clipboard；它不绑定 Very Happy Web 终端。独立 very-happy mcp 命令不会添加标题、预览、进度、派生或 provider 路由，并且需要本地 daemon。工具可用性因 runner 而异，不是通用 MCP 承诺。'] },
      { heading: '组合边界', blocks: ['Very Happy 把组织专属集成留在核心之外。适配器决定哪些消息可信、哪些机器和目录可以执行任务，以及启动哪个 Agent。产品只提供通用 HTTPS 通知和本地已认证 CLI 命令。', 'IM 消息是不可信输入，不是授权。请使用明确的 sender/room allowlist、固定目录映射、最小权限 daemon 用户，并对破坏性操作进行确认。'] },
      { heading: '一种部署模式', blocks: ['IM 适配器可以接收已授权任务标记，在固定允许工作区中通过本地 daemon 调用 very-happy spawn，把完成或权限事件转发到指定会话，并把已授权的引用回复通过 very-happy send 映射回去。该契约刻意不依赖任何聊天厂商。', '聊天适配器与 Claude 驱动的 Web/语音协调器目前是两条独立扩展路径。适配器不要求经过协调器。执行遵循已配置的 Agent 权限模式。', null, '阅读 webhook、spawn、send、MCP 与 todo-provider 契约 ↗'] },
      { heading: '个人 Agent 系统', blocks: ['实用的 Agent 系统会把稳定操作规则与凭据、公司专属知识分离。把小而可审查的 skills 与路由策略放进版本控制，只在运行时渲染 secret，并通过文档化适配器连接 Very Happy。我们计划发布脱敏参考套件，而不是导出私人运营环境。'] },
    ],
  },
  security: {
    label: '安全与隐私', summary: '真实的信任模型、远程执行边界与运营方责任。',
    sections: [
      { heading: '服务端可信设计', blocks: ['产品采用服务端可信架构。', 'Very Happy 不是端到端加密或零知识系统。服务端运营方——或控制服务端的攻击者——可以访问中继保存的内容、恢复账户密钥，并影响发送给在线 daemon 的请求。', '只使用你信任其运营方和安全状态的中继。自托管会改变你信任谁，但不会从架构中移除可信中继。'] },
      { heading: '机器授权', blocks: [['只批准由你自己的 CLI 命令生成的链接。', '应把已连接 daemon 视为对该用户账户的远程执行权限。', '以满足需求的最低 OS 权限运行 daemon，并保持宿主机更新。', '怀疑泄露后断开机器并轮换凭据。']] },
      { heading: '数据处理', blocks: ['根据功能不同，会话、终端流量、账户元数据、日志、附件、通知与集成数据可能经过中继或持久化在中继上。运营方应记录部署的保留策略、备份、子处理方和事故响应。', '邮箱验证码登录会在可信中继上保存规范化邮箱地址。配置的邮件 provider 会依据自己的处理与保留条款接收目标地址、发件人和一次性验证码。', '终端文件交接会经过可信中继，并落到选中机器的 ~/.happy/uploads/terminal/。当前客户端单文件上限 8 MB，使用有界分块传输，只把按 daemon 默认 shell 引用的路径粘贴出来；不会执行文件或按 Enter。原生 Windows 路径插入需要当前 daemon 区分 cmd 与 PowerShell。'] },
    ],
  },
  'accounts-and-quotas': {
    label: '账户与配额', summary: '注册模式、容量提示、限流与账户恢复。',
    sections: [
      { heading: '注册结果', blocks: [['达到容量：无法创建新的公共账户；请稍后再试或自托管。', '暂停注册：既有用户仍可登录；策略问题请联系运营方。', '需要邀请：邮箱、Google 或密码首次注册前输入运营方提供的邀请码。', '触发限流：停止重试，等待一段时间后只重试一次。']] },
      { heading: '身份验证', blocks: ['部署可以提供无密码邮箱验证码、Google，以及可选的用户名/密码。配置已验证发件人后，推荐邮箱验证码。Google 依赖精确 Web origin 的 OAuth client；运营方关闭兼容密码路径后，密码控件会消失。', '已经有密码或 Google 账户？请先用原方式登录，再打开“设置 → 账户 → 邮箱登录”并验证地址。开放中继上的未关联邮箱登录可能创建独立账户；看起来相同的 Google 邮箱绝不会自动合并。'] },
      { heading: '运营方控制', blocks: ['容量是全局注册安全上限，不是用量权益。机器、会话、加密状态、消息、附件、access key、artifact、feed、KV、push token、usage report、socket 与 RPC 都有独立边界。持久化写入者在 HTTP 与 Socket.IO 之间共享数据库账户锁，因此换客户端无法绕过配额。', ['400：缩短或修正被拒绝的字段/批次。Access-key envelope 必须是规范 base64，解码后最多 4096 字节。', '413 / *_bytes_quota_exceeded：删除可释放数据或联系运营方。', '429 / *_count_quota_exceeded：删除可释放记录或联系运营方。', '429 / *_rate_quota_exceeded：停止重试，等待一分钟窗口。'], '加密的会话/机器 metadata 上限 256 KiB，state 上限 512 KiB；大写入按 64 KiB 单位计费。Feed 与上传行有独立账户上限。上传 URL 会预留字节与一行记录；未完成的预留及对象会在运营方配置的 TTL 后回收（默认 60 分钟）。'] },
    ],
  },
  upgrades: {
    label: '升级与回滚', summary: '在保持协议和 daemon 兼容的前提下安全更新。',
    sections: [
      { heading: '升级前', blocks: [['阅读发布说明与兼容矩阵。', '备份持久存储，并记录当前 server、web 与 CLI 版本。', '运行包级门禁与 clean-install 冒烟。', '准备精确的上一版 artifact 或 commit 作为回滚材料。']] },
      { heading: '顺序', blocks: ['通常顺序是 server → web → CLI。发布 spec 可能要求不同的兼容顺序。server RPC 注册或 CLI 代码变化后请重启 daemon。', null] },
      { heading: '回滚', blocks: ['恢复上一版 Web assets、server source/image 与 CLI package。优先使用向前兼容 migration；不要在事故中临时发明破坏性的 down migration。'] },
    ],
  },
  troubleshooting: {
    label: '故障排查', summary: '从登录、配对、机器离线与服务故障中恢复。',
    sections: [
      { heading: '无法登录或注册', blocks: [['重试前先检查中继健康状态和网络。', '邮箱验证码无效时，只申请一个新验证码，并只使用最新邮件。', '出现容量、关闭注册或邀请提示时，按对应策略处理，不要重复提交。', 'Google 失败时允许一次弹窗，或在启用时改用邮箱/密码登录。']] },
      { heading: '机器没有出现', blocks: [null, ['确认 CLI 与浏览器使用同一个中继。', '重新运行 very-happy auth login，并批准新生成的链接。', '确认 daemon PATH 能解析你准备运行的工具。', '升级后重启 daemon，再重新加载 Web App。']] },
      { heading: '服务不可用', blocks: ['不要循环执行破坏性操作。先保留本地工作，检查中继 health endpoint 与运营方状态；如果你负责该部署，请使用文档化回滚流程。'] },
    ],
  },
  contributing: {
    label: '参与贡献', summary: '从 clean checkout 构建受支持的 Web V2、server、wire 与 CLI 路径。',
    sections: [
      { heading: '受支持的开发路径', blocks: [null, 'happy-web-v2 是生产客户端。保留的 Expo/Tauri happy-app 只是未来桌面客户端的实验种子，不是当前版本支持的前端。'] },
      { heading: '变更纪律', blocks: [['提交聚焦的变更，并按风险配套测试。', '修改协议、状态模型、存储语义或跨多个包之前先写 spec。', '绝不提交凭据、私人会话数据、生成的 home 或生产日志。', '保持旧客户端兼容，并记录部署顺序。']] },
      { heading: '署名与许可证', blocks: ['Very Happy 是 slopus/happy 的深度修改 fork。分发构建或提交 patch 前，请阅读仓库许可证、NOTICE 与贡献指南。'] },
    ],
  },
};
