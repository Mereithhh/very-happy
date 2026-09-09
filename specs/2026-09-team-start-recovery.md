# 团队启动恢复与聊天式创建

状态：Shipped · 2026-09-10 · B-438

## 已核验问题

生产 TODO 消除的唯一负责人 sessionId=null，当前 spawn status=failed、错误为绝对路径要求，directory=~/code/github/skills；本地 prepared receipt 阶段在 worktree 建立前失败。任务 queued 不能代表正在等待正常启动。侧栏以 bot 数计数却只生成 session 行，导致成员展开为空。任务详情未展示对应 operation.error。

## 修复契约

- 执行机器将 `~` / `~/` 解析为自己的 OS home，之后仍要求绝对路径并做真实 Git 仓库验证。不使用 shell 展开，不把 HAPPY_HOME_DIR 当用户 home。相对路径、~other 保持拒绝。
- 保留 operation id、claim 和 receipt；prepared 重试安全，spawning 不确定状态不得重复 spawn。新版 daemon 可以在原 operation 恢复，不创建另一个团队。
- 当前 attempt 的失败/未知启动原因在任务详情、工作台和侧栏可见；不存在会话的成员仍有可点击的任务入口，不伪造会话链接。
- 创建团队以目标消息为中心，复用最近机器/路径作为可见可修改默认值，展开配置可选 agent/项目/机器等；未知路径必须选择，不猜工作目录。保留请求幂等和失败草稿，成功自动进入负责人对话。

## 兼容与发布

无 wire/存储变更。旧 CLI 可运行 Web 提交的绝对路径，新 CLI 支持原先已保存的 ~/ 任务。先 server/Web，再 CLI/daemon。已有不确定操作不自动重建；生产恢复须核对同一 operation 和唯一 wrapper。保留当前完整镜像及 CLI 0.2.131 作为回退。

## 验证

真实 Git worktree 的 ~/ 路径与重复调用；当前尝试错误与旧错误隔离；无会话成员展开；创建表单幂等与选择；明暗、320/390 桌面浏览器；全包门禁与整批 review；上线后核对原任务进入实际会话。

## 实施与 review

已完成整批 diff 回扫：执行端不经 shell、不降低 Git/资源所有权校验；原 prepared receipt 重试沿用 claim，spawning 不改；Web 不替换未决 requestId；跨账号切换后的异步结果不会把旧路径写到新账号。浏览器抓到紧凑侧栏隐藏副标题，改为同一标题行显式状态；unknown 使用“需处理”而不宣称已失败。

本地门禁：wire 82、Web 2744、CLI 2082、server 644 通过，构建/tsc/CLI 生成产物通过。真实浏览器验证 1280/390/320 × 明暗主题，侧栏未启动成员可达、折叠配置、延迟提交与原请求保留；CSS probe 前后取证，手机控件 17px、发送按钮 44px、无横向溢出。

## 发布与真实恢复

PR #326 合并为 `50e67bc12dbee25a7f1031cfbe74cc7491dda8bd`。PR 及 main 精确 SHA 门禁通过。Web/server 部署 run `34406697129` 成功，active green 镜像 `sha256:0bb002efda0f772d4270ef10257da62055c11116cdb750ccd716b329fa332f90`，保留 blue `82c12b9d5` 镜像供回退。线上入口 SHA 与三个功能标记命中，52 个资源核对、health 及 18 项生产页面检查通过。

CLI `v0.2.132` 指向同一 SHA；publish/promote run `34407151156`、push smoke run `34407151138` attempt 1 全部成功，Linux/macOS/Windows × Node20/24 六格齐全；npm latest/next 都为 0.2.132。推荐版本 API 当时仍处于 registry 的 1h 缓存窗口，未修改独立 auto-update pin。mac-office 安装固定 0.2.132 后通过 daemon start 接管，并在原 spawn 已完成后重新纳入 launchd；installed/running 0.2.132、launchd running，中央与区域 fs-list 均成功。

生产原团队保持原 team、task、operation 和 claim；prepared 记录继续执行，spawn 变 completed、task 变 running，仅一个负责人会话绑定。REST 消息验收证明 initial localId 存在、目标全文保持且只有一个 user 消息，随后已有 agent turn-start、tool-call-start 与 tool-call-end。没有重复创建团队，也没有替换用户“交付和对外发送前确认”的目标要求。此验收证明启动和执行已恢复，不代表用户业务任务已完成。

临时证据在 `~/code/github/skills/tmp/vh-team-recovery/`。公开记录不含凭据、消息正文或用户会话标识。
