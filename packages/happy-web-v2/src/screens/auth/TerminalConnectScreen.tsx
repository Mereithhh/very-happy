import { useEffect, useState } from 'react';
import { CheckCircle2, MonitorUp, ShieldCheck } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { isTrustedAuthCredentials } from '@/auth/tokenStorage';
import { authApprove } from '@/auth/authApprove';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { sync } from '@/sync/sync';
import { Button, CyberMark } from '@/ui';
import { buildTerminalApproval, terminalPublicKeyFromHash } from './terminalConnect';
import './terminalConnect.css';
import { useTranslation } from '@/i18n/useTranslation';

type State = 'ready' | 'approving' | 'done' | 'error';

export function TerminalConnectScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const { credentials } = useAuth();
  const { t } = useTranslation();
  const [publicKey] = useState(() => terminalPublicKeyFromHash(location.hash));
  const [state, setState] = useState<State>('ready');
  const fingerprint = publicKey ? encodeBase64(publicKey, 'base64url').slice(0, 12) : null;

  // The request key is a pairing capability. Keep it only in memory so it is
  // not retained by browser history, screenshots, synced tabs, or extensions
  // that inspect URLs after the approval page has loaded.
  useEffect(() => {
    if (!location.hash) return;
    window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`);
  }, [location.hash, location.pathname, location.search]);

  async function approve() {
    if (!credentials || !publicKey) return;
    if (!isTrustedAuthCredentials(credentials)) {
      // The legacy approval would hand a server-known account secret to the
      // runner. E2EE runners use the separate scoped certificate flow.
      setState('error');
      return;
    }
    setState('approving');
    try {
      const answer = buildTerminalApproval(
        decodeBase64(credentials.secret, 'base64url'),
        sync.encryption.contentDataKey,
        publicKey,
      );
      await authApprove(credentials.token, publicKey, answer.legacy, answer.dataKey);
      setState('done');
    } catch (error) {
      console.error('[terminal-connect] approval failed', error);
      setState('error');
    }
  }

  return (
    <main className="tc-page">
      <section className="tc-card" aria-labelledby="terminal-connect-title">
        <div className="tc-brand"><CyberMark size={36} glow /><span>very happy</span></div>
        {state === 'done' ? (
          <>
            <CheckCircle2 className="tc-status tc-status--live" size={42} />
            <h1 id="terminal-connect-title">{t('terminalConnect.connectedTitle')}</h1>
            <p>{t('terminalConnect.connectedDescription')}</p>
            <Button variant="primary" onClick={() => navigate('/', { replace: true })}>{t('terminalConnect.openApp')}</Button>
          </>
        ) : !publicKey ? (
          <>
            <ShieldCheck className="tc-status" size={42} />
            <h1 id="terminal-connect-title">{t('terminalConnect.invalidTitle')}</h1>
            <p>{t('terminalConnect.invalidDescription')}</p>
            <Button onClick={() => navigate('/', { replace: true })}>{t('terminalConnect.back')}</Button>
          </>
        ) : (
          <>
            <MonitorUp className="tc-status" size={42} />
            <h1 id="terminal-connect-title">{t('terminalConnect.title')}</h1>
            <p>{t('terminalConnect.description')}</p>
            <div className="tc-fingerprint"><span>{t('terminalConnect.request')}</span><code>{fingerprint}…</code></div>
            {state === 'error' && <div className="tc-error" role="alert">{t('terminalConnect.error')}</div>}
            <Button variant="primary" fullWidth loading={state === 'approving'} onClick={approve}>
              {t('terminalConnect.approve')}
            </Button>
            <Button variant="ghost" fullWidth disabled={state === 'approving'} onClick={() => navigate('/', { replace: true })}>
              {t('terminalConnect.cancel')}
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
