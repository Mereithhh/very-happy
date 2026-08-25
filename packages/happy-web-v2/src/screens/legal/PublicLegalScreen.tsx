import { Link } from 'react-router-dom';
import { CyberMark } from '@/ui/CyberMark';
import './publicLegal.css';

const UPDATED = 'August 24, 2026';
const PRIVATE_CONTACT_URL = 'https://github.com/Mereithhh/very-happy/security/advisories/new';

export function PrivacyScreen() {
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
  return (
    <main className="legal-page">
      <article className="legal-card">
        <Link className="legal-brand" to="/welcome"><CyberMark size={32} /><span>very happy</span></Link>
        <h1>{title}</h1>
        {children}
        <footer><Link to="/privacy">Privacy</Link><span>·</span><Link to="/terms">Terms</Link><span>·</span><a href="https://github.com/Mereithhh/very-happy">Source</a></footer>
      </article>
    </main>
  );
}
