# Tanka / Ridge 接入面调研

> 2026-10-17 子代理调研，来源为内部知识库（消息渠道、数据平台与 SSO 相关笔记）与 open.tanka.ai。供 specs/2026-10-spaces-a2a.design.md 引用。

## 结论
「数据在 Tanka 体系内」在现有能力下只能落成「Tanka 身份 + Tanka AI 能经 Ridge 查到 very-happy 数据 + 事件进 Tanka 群」，做不到把空间/会话物理存进 Tanka：开放平台没有自定义 agent 注册、没有普通消息事件订阅、建群/拉人 restricted。

## 1. Tanka 对象模型与开放面
- 对象：org（一账号多 org，userId 按 org 不同）、room/group（roomType 2=DM/3=群/4=assistant）、member/department、workspace（memo 共享空间，与 group 不是同一实体）、memo、vote/verification、follow-up、日历、Flow（Tanka AI 对话房）、App/Bot。
- 五套互相独立接口：①MCP 47 个 open 工具（memo/消息/群读/workspace/vote）；②REST OAuth2 仅 4 端点（成员/部门/profile）；③Web API 文件上传 + `/link/workmemory/*`（给 coding agent 的 worklog 同步）；④Agent Tools 是否对第三方开放未说明；⑤App 基础设施：Incoming Webhook、Slash Command、Event Subscriptions。
- 事件订阅只有 `app_mention` + 5 个 `verification_*`（10-17 复核）；无普通消息事件。
- 未开放：create_group/add_members restricted、联系人/日历/follow-up restricted 或 internal。
- Tanka AI 取数靠私有协议 `tanka-remote-routes/1` 挂载，由 Tanka 侧手工配置，不在 open.tanka.ai。agent 不能发起 Flow、不能向 Tanka AI 提问。
- 「团队记忆/EverMemOS」只有产品文案，API 未披露；memory 唯一可写入口是 workmemory。

## 2. Ridge 定位与接入所得
- 定位：业务数据与上下文中心、内部开放平台；Tanka 只是提问入口。
- 已开放：人事副本（含 `tanka_user_id`）、电话告警、群通知 `/v1/notify/*`、Tanka 接入（provider）、MCP `/mcp`、人事变动 webhook。推进中未上线：统一 ID、关联、Trace、事件推送、统一凭证。
- 接入三件事：建 provider、维护 spec（GET 工具→自己的 REST）、用 SDK 验 Ridge RS256 JWT（`sub`=email、`person_id`、`role`、`scn`、`via`）。Ridge 查询时实时调平台接口、不存响应正文、不做 feeds/events 同步。写工具需四道闸。激活/曝光由管理员或 oncall agent 做。
- 得到：Tanka AI 生产可查、同一曝光自动进 MCP 给个人 agent、调用审计。得不到：SSO（Ridge 自身用 Authentik）、Tanka 侧推送。

## 3. 四条路径
| 路径 | 覆盖 | 依赖 | 风险/判断 |
|---|---|---|---|
| A Ridge provider + MCP | Tanka AI/同事 agent 查空间、会话、任务；审计 | Ridge 管理员激活；very-happy 出只读 GET | 只读查询面，不承载 a2a 与实时消息；敏感会话需按 `sub` 做 ACL |
| B Bot/Webhook 镜像到群 | 事件、完成通知、@人；现有 webhook 契约已成 | apodex-bot 或 Ridge `/v1/notify`、官方 Incoming Webhook | 单向；回流只能靠引用回复 trailer；bot 发不了私聊 |
| C Tanka SSO 身份 + group 当空间 | 身份可行；group 当空间不可行（建群 restricted、无消息事件） | Authentik OIDC | 空间仍在 very-happy，只映射成员 |
| D open.tanka.ai agent 接入 | 无此能力：无自定义 agent 注册 | — | 不可选 |

## 4. 身份映射
三种做法并存：①扫码 SSO（WASM 签名+后端转发，email 为唯一身份）；②官方 OAuth2 `openid/profile/email`，需组织管理员装 App；③Authentik 已有「Log in with Tanka」源 + `ridge_profile` scope 直接拿部门/团队/上级。映射键一律 email，Ridge 可反查 `person_id`/`tanka_user_id`。very-happy Account 已支持多登录身份。推断：加一个 OIDC 身份=Authentik 即可。个人/副业系统接公司身份源须 jojo 明确确认。

## 5. 推荐
Authentik OIDC（经它拿 Tanka 身份与组织树）+ Ridge provider/MCP 暴露空间与会话只读数据 + Ridge `/v1/notify` 或 apodex-bot 把事件推群。三者都是已上线、有 owner 的面。Tanka 开放平台既无 agent 注册也无消息事件，agent-to-agent 与空间状态只能留在 very-happy 自己的 server。待 Ridge 事件推送/统一凭证上线后再考虑把会话事件流接进 Ridge。
