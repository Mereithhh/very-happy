# 任意文件附件与 50 MB 边界

> 状态：Final
> 日期：2026-08-27 ｜ 关联 backlog：B-241 ｜ 前身：`2026-08-session-continuity-attachments-capabilities.md`

## 背景

普通对话已支持图片与 PDF，但 Web、server 和 Claude adapter 各自保留了类型或 10 MB
限制。用户需要把解析能力交给 coding agent：产品只负责把任意文件可靠送到 agent 可访问的
机器路径，单文件上限统一为 50 MB。

## 目标

- 新 Web + 新 daemon 接受任意 MIME/扩展名的文件选择、粘贴与拖放，单个原文件不超过 50 MB。
- relay 继续把附件视为 opaque encrypted blob，不解析文件内容或信任 MIME。
- daemon 原子落盘到私有附件目录，并在同一条用户 query 中提供绝对路径，由 coding agent
  自行选择 Read、脚本或其他工具解析。
- 旧 Web/CLI 组合可预测降级，不出现“选得上但发送后静默丢失”。

## 非目标

- 不在浏览器、server 或 daemon 内新增 Office/压缩包/媒体解析器。
- 不改变 Web terminal 文件交接独立的 8 MB 分块上传限制。
- 本批不把附件扩展到尚未消费 session file event 的 Codex/Gemini/ACP/OpenClaw adapter；
  这些 flavor 继续显式提示不支持，不能静默发送空附件。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| composer 只接受四类图片和 PDF，原文件保守限制约 10 MB | `packages/happy-web-v2/src/screens/session/useAttachments.ts:37`、`AgentInput.tsx:686` |
| encrypted attachment endpoint 的 request/local body 上限均为 10 MB | `packages/happy-server/sources/app/api/routes/attachmentRoutes.ts:22` |
| blob 加密固定增加 24-byte nonce + 16-byte auth tag | `packages/happy-web-v2/src/encryption/blob.ts:7` |
| CLI 下载限制 10 MB，Claude adapter 只按 magic bytes 接受图片/PDF | `packages/happy-cli/src/api/apiSession.ts:447`、`packages/happy-cli/src/claude/utils/attachmentContent.ts:43` |
| 其他 agent adapter 尚未注册 session file event 消费者 | `packages/happy-cli/src/claude/runClaude.ts:565` |

## 设计

Web 的附件模型不再以 MIME 判断支持性；任意 `File` 都生成文件 chip，只有已知浏览器可预览的
图片生成缩略图。大小边界以原文件 `50 * 1024 * 1024` 为准。CLI metadata 用 `*/*` 表示
“任意文件可可靠落盘”；新 Web 只有看到该能力时才对当前 Claude session 放开通配选择，面对
旧 CLI 仍按其明确的 image/PDF 列表过滤并提示升级。

server 接受的 encrypted blob 上限为 50 MB + 40 bytes，账户 quota 仍按实际加密字节计数。
server 不读取 MIME 或明文。CLI 下载使用同一传输上限，解密后再强制校验原文件不超过 50 MB。

daemon 使用经过 basename/字符清洗的文件名和随机后缀，原子写入
`$HAPPY_HOME_DIR/uploads/chat/<session-id>/`，目录/文件权限分别为 0700/0600（Windows 权限能力
不足时沿用现有安全 helper 的兼容行为）。给 SDK 的用户 query 追加一个明确的 attached-files
段，列出绝对路径与原始显示名；不把文件内容转成 base64 模型 block，解析责任完全交给 agent。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 旧 Web + 新 CLI | 仍只显示图片/PDF入口；CLI 可继续处理这些文件，不破坏旧行为 |
| 新 Web + 旧 CLI | 按旧 metadata 只允许已声明的图片/PDF；其他文件提示升级，不上传 |
| 新 Web + 新 CLI + 新 server | 任意单文件 ≤50 MB 落盘并把路径交给 Claude coding agent |
| 新 Web + 新 CLI + 旧 server | >约10 MB 上传会失败并明确提示；小文件仍可工作 |

发布顺序：server → CLI → `vh-update` → Web。回滚 Web/CLI 后恢复图片/PDF能力；server 的较大
opaque blob 上限对旧客户端无行为影响。

## 风险

1. 文件名路径穿越：只使用 basename 后的安全字符，并添加随机后缀；server ref 仍不含用户文件名。
2. 大文件内存峰值：现有链路在 Web 加密与 CLI 解密时各持有完整 buffer；50 MB 可接受但不伪装成
   流式。后续若提高上限，必须先改流式加解密。
3. 附件内容可能包含指令：query 明确把路径标为 attached files/data；是否读取及如何解释由 coding
   agent 与用户请求共同决定。
4. 旧 server 的较小上限：Web 保留上传失败反馈；按规定发布顺序先扩 server。

## 验收标准

- [ ] `.zip`、无 MIME 文件和图片均可经 picker/drop/paste 加入，新 Web 不按扩展名拒绝。
- [ ] 50 MB 原文件可进入上传；50 MB + 1 byte 在浏览器选择阶段被拒绝并显示具体限制。
- [ ] daemon 落盘文件字节完全一致、文件名不可穿越、附件-only query 仍包含可读路径。
- [ ] 新 Web 面对旧 CLI 不允许任意文件；新 CLI metadata 明确宣告 `*/*`。
- [ ] Web、server、CLI 全量门禁与 CLI runtime smoke 全绿。

## 留真机验证项

- iOS/Android 的系统文件 picker 对未知 MIME、50 MB 文件与后台切换时的上传进度体验。
