import { Link } from 'react-router-dom';
import { CyberMark } from '@/ui/CyberMark';
import { usePublicI18n } from '@/i18n/publicI18n';
import { useEffect } from 'react';
import './publicLegal.css';

const UPDATED = 'August 24, 2026';
const PRIVATE_CONTACT_URL = 'https://github.com/Mereithhh/very-happy/security/advisories/new';

export function PrivacyScreen() {
  const { language } = usePublicI18n();
  if (language === 'zh-Hans') return <LegalPage title="隐私政策">
    <p><strong>最后更新：</strong>2026 年 8 月 24 日</p>
    <p>very happy 是面向编程 Agent 的开源远程 Web 客户端。本政策适用于 veryhappy.dev 托管实例。自托管部署由其管理员运营，可能采用不同做法。</p>
    <h2>我们处理的数据</h2>
    <p>我们会处理账户标识、登录会话、机器元数据、会话与终端流量、你主动发送的文件或提示词，以及安全运维日志。使用 Google 登录时，我们会收到 Google 账户 subject、已验证邮箱、姓名与头像。</p>
    <h2>数据用途</h2>
    <p>这些信息用于身份验证、连接机器、中继与同步会话、防止滥用、诊断故障和运营服务。我们不会出售个人信息，也不会把会话内容用于广告。</p>
    <h2>服务端可信模型</h2>
    <p>本托管服务采用服务端可信架构，不是零知识端到端加密。服务端能够恢复账户密钥、签发登录令牌、访问中继的会话内容，并调用账户可用的已连接机器能力。不要向公共实例发送生产密钥或其他敏感信息；敏感工作请使用自托管。</p>
    <h2>服务提供商与可选集成</h2>
    <p>托管与数据库提供商会处理运行服务所需的数据；Google 处理登录。启用相应功能后，Web Push 或 Expo 可能传递通知元数据，ElevenLabs 可能处理语音与文本，GitHub 或其他已连接厂商可能收到凭据和 API 请求，你配置的 webhook 目标也可能收到通知内容。各提供商适用自己的条款与隐私政策。</p>
    <h2>保留期限</h2>
    <p>只要账户存在或仍有运维需要，数据就可能继续保留；安全日志可能保留一段有限时间。公共演示实例可能被重置，数据也可能在不另行通知的情况下删除。</p>
    <h2>你的选择</h2>
    <p>你可以退出登录，也可以通过仓库的<a href={PRIVATE_CONTACT_URL}>私密报告渠道</a>申请删除账户和数据。如果该渠道不可用，请仅创建一个公开 issue 请求私密联系方式，不要附带账户详情或会话内容。撤销 Google 授权会阻止未来的 Google 授权，但不会自动退出现有 very happy 会话或删除数据。</p>
    <h2>联系我们</h2>
    <p>隐私问题或删除请求请使用<a href={PRIVATE_CONTACT_URL}>私密报告渠道</a>。</p>
  </LegalPage>;
  return (
    <LegalPage title="Privacy Policy">
      <p><strong>Last updated:</strong> {UPDATED}</p>
      <p>very happy is an open-source remote Web client for coding agents. This policy describes the hosted instance at veryhappy.dev. A self-hosted deployment is operated by its own administrator and may follow different practices.</p>
      <h2>Data we process</h2>
      <p>We process account identifiers, login sessions, machine metadata, session and terminal traffic, files or prompts you choose to send, and operational security logs. If you sign in with Google, we receive your Google account subject, verified email address, name, and profile image.</p>
      <h2>How data is used</h2>
      <p>We use this information to authenticate you, connect your machines, relay and synchronize sessions, prevent abuse, diagnose failures, and operate the service. We do not sell personal information or use session content for advertising.</p>
      <h2>Server-trusted model</h2>
      <p>This hosted service is server-trusted, not zero-knowledge end-to-end encrypted. The server can recover account secrets, issue login tokens, access relayed session content, and invoke the connected-machine capabilities available to your account. Do not send production secrets or other sensitive information to the public instance. Self-host for sensitive work.</p>
      <h2>Service providers and optional integrations</h2>
      <p>Hosting and database providers process data needed to run the service. Google processes sign-in. If you enable the relevant feature, Web Push or Expo may deliver notification metadata, ElevenLabs may process voice audio and text, GitHub or another connected vendor may receive credentials and API requests, and a webhook destination you configure may receive notification content. Those providers apply their own terms and privacy policies.</p>
      <h2>Retention</h2>
      <p>Data is retained while your account or an operational need exists; security logs may be kept for a limited period. The public demo may be reset and data may be deleted without notice.</p>
      <h2>Your choices</h2>
      <p>You may log out or request account and data deletion through the repository&apos;s <a href={PRIVATE_CONTACT_URL}>private reporting channel</a>. If it is unavailable, open a public issue asking for a private contact channel and include no account details or session content. Revoking Google access stops future Google authorization but does not itself log out existing very happy sessions or delete your data.</p>
      <h2>Contact</h2>
      <p>For privacy questions or deletion requests, use the <a href={PRIVATE_CONTACT_URL}>private reporting channel</a>.</p>
    </LegalPage>
  );
}

export function TermsScreen() {
  const { language } = usePublicI18n();
  if (language === 'zh-Hans') return <LegalPage title="服务条款">
    <p><strong>最后更新：</strong>2026 年 8 月 24 日</p>
    <p>使用托管的 very happy 实例即表示你同意这些条款。如果不同意，请勿使用本服务。</p>
    <h2>公共演示服务</h2>
    <p>托管实例是容量有限的公共演示服务，按现状提供，不承诺在线率、支持、持久性或特定用途适用性。账户、限制、功能和已存储数据可能随时变更或删除。你也可以依据仓库许可证自托管源代码。</p>
    <h2>你的责任</h2>
    <p>你应对通过自己账户和已连接机器进行的活动负责。请妥善保管凭据，只连接自己控制的机器，遵守适用法律，不得滥用、攻击、过载或干扰服务及其他用户。</p>
    <h2>敏感数据</h2>
    <p>托管服务采用服务端可信架构。请勿提交生产密钥、受监管数据，或其他需要保密和保证存储的信息。当你需要掌控基础设施和数据时，请自托管中继。</p>
    <h2>暂停与可用性</h2>
    <p>为保护容量、安全、用户或服务，我们可能限制或暂停访问，也可能停止托管实例。在法律允许的范围内，运营方不对使用演示服务造成的数据丢失、工作中断或间接损失承担责任。</p>
    <h2>联系我们</h2>
    <p>需要提供私密账户详情的问题，请使用<a href={PRIVATE_CONTACT_URL}>私密报告渠道</a>；其他问题请使用仓库 issue tracker。</p>
  </LegalPage>;
  return (
    <LegalPage title="Terms of Service">
      <p><strong>Last updated:</strong> {UPDATED}</p>
      <p>By using the hosted very happy instance, you agree to these terms. If you do not agree, do not use the service.</p>
      <h2>Public demo</h2>
      <p>The hosted instance is a limited public demo, provided as-is without uptime, support, durability, or fitness guarantees. Accounts, limits, features, and stored data may be changed or removed at any time. The source code may also be self-hosted under its repository license.</p>
      <h2>Your responsibilities</h2>
      <p>You are responsible for activity performed through your account and connected machines. Keep credentials secure, connect only machines you control, follow applicable law, and do not abuse, attack, overload, or interfere with the service or other users.</p>
      <h2>Sensitive data</h2>
      <p>The hosted service is server-trusted. Do not submit production secrets, regulated data, or other information that requires confidential or guaranteed storage. Self-host the relay when you need control over infrastructure and data.</p>
      <h2>Suspension and availability</h2>
      <p>We may limit or suspend access to protect capacity, security, users, or the service. We may discontinue the hosted instance. To the extent permitted by law, the operator is not liable for lost data, interrupted work, or indirect damages arising from use of the demo.</p>
      <h2>Contact</h2>
      <p>For questions that require private account details, use the <a href={PRIVATE_CONTACT_URL}>private reporting channel</a>; otherwise use the repository issue tracker.</p>
    </LegalPage>
  );
}

function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  const { language, copy } = usePublicI18n();
  useEffect(() => { document.title = `${title} — Very Happy`; }, [language, title]);
  return (
    <main className="legal-page">
      <article className="legal-card">
        <Link className="legal-brand" to="/welcome"><CyberMark size={32} /><span>very happy</span></Link>
        <h1>{title}</h1>
        {children}
        <footer><Link to="/privacy">{copy.shell.privacy}</Link><span>·</span><Link to="/terms">{copy.shell.terms}</Link><span>·</span><a href="https://github.com/Mereithhh/very-happy">{copy.shell.source}</a></footer>
      </article>
    </main>
  );
}
