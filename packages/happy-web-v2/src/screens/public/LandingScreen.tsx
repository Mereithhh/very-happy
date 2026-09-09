import { ArrowRight, Cable, Github, Globe2, MonitorSmartphone, Server, TerminalSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { PublicFooter, PublicHeader } from './PublicShell';
import { CoreFeatureProofs } from './CoreFeatureProofs';
import { KeyboardWorkflowProof } from './KeyboardWorkflowProof';
import { MobileContinuityProof } from './MobileContinuityProof';
import { ProductWorkspacePreview } from './ProductWorkspacePreview';
import { GlobalRelayMap } from './GlobalRelayMap';
import { RuntimeArchitectureProof } from './RuntimeArchitectureProof';
import { TeamsDiagram, TeamsStory } from './TeamsStory';
import { WhyVeryHappy } from './WhyVeryHappy';
import { DAEMON_START_COMMAND, GITHUB_URL, INSTALL_COMMAND, LOGIN_COMMAND } from './publicContent';
import { usePublicI18n } from '@/i18n/publicI18n';
import './public.css';

function ProductShowcase() {
  const { language, copy } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const c = copy.landing;
  return <section className="pub-product" aria-labelledby="product-title">
    <div className="pub-product-intro"><div><div className="eyebrow">{c.productEyebrow}</div><h2 id="product-title">{c.productTitle}</h2></div><p>{c.productBody}</p></div>
    <div className="pub-product-frame"><div className="pub-product-frame-head mono"><span><i /> {zh ? '账户工作区 · 生产 UI 契约' : 'ACCOUNT WORKSPACE · PRODUCTION UI CONTRACTS'}</span><span>3 {zh ? '台机器' : 'MACHINES'} · CLAUDE + CODEX + TTY</span></div><ProductWorkspacePreview fileTransferDemo /></div>
    <div className="pub-product-caption mono"><span>{zh ? '一个侧栏 · 多机器工作' : 'ONE SIDEBAR · MULTI-MACHINE WORK'}</span><span>{zh ? '粘贴文件 → 选定机器 · 8 MB · 不自动执行' : 'PASTE FILE → SELECTED MACHINE · 8 MB · NO AUTO-RUN'}</span><span>{zh ? '派发 · 观察 · 接管' : 'DISPATCH · WATCH · STEP IN'}</span></div>
    <div className="pub-product-facts">
      <article><MonitorSmartphone size={18} /><div><span className="mono">{c.webRecommended}</span><strong>{c.webRecommendedBody}</strong></div></article>
      <article><Cable size={18} /><div><span className="mono">{c.bridge}</span><strong>{c.bridgeBody}</strong></div></article>
      <article><TerminalSquare size={18} /><div><span className="mono">{c.agents}</span><strong>{c.agentsBody}</strong></div></article>
    </div>
    <div className="pub-product-links"><Link to="/docs/architecture">{c.architecture} <ArrowRight size={14} /></Link><Link to="/docs/integrations">{c.matrix} <ArrowRight size={14} /></Link></div>
  </section>;
}

function RegionalRelayProof() {
  const { copy } = usePublicI18n();
  const c = copy.landing;
  return <section className="pub-relay" aria-labelledby="relay-title">
    <div className="pub-relay-copy">
      <div className="eyebrow">{c.relayEyebrow}</div>
      <h2 id="relay-title">{c.relayTitleA}<br /><span>{c.relayTitleB}</span></h2>
      <p>{c.relayBody}</p>
      <div className="pub-relay-facts mono">
        <span>{c.relayFactRtt}</span>
        <span>{c.relayFactVisible}</span>
        <span>{c.relayFactFallback}</span>
      </div>
      <Link to="/docs/architecture">{c.relayLink} <ArrowRight size={14} /></Link>
    </div>
    <GlobalRelayMap />
  </section>;
}

function StartAndTrust() {
  const { copy } = usePublicI18n();
  const c = copy.landing;
  return <section className="pub-start" aria-labelledby="start-title">
    <header className="pub-start-head">
      <div className="eyebrow">{c.startEyebrow}</div>
      <h2 id="start-title">{c.startTitle}</h2>
      <p>{c.startBody}</p>
    </header>
    <div className="pub-start-main">
      <ol>
        <li><span className="mono">01</span><div><h3>{c.stepOne}</h3><p>{c.stepOneBody}</p></div></li>
        <li><span className="mono">02</span><div><h3>{c.stepTwo}</h3><code>{`${INSTALL_COMMAND}\nvery-happy doctor`}</code><p>{c.stepTwoBody}</p></div></li>
        <li><span className="mono">03</span><div><h3>{c.stepThree}</h3><code>{`${LOGIN_COMMAND}\n${DAEMON_START_COMMAND}`}</code><p>{c.stepThreeBody}</p></div></li>
      </ol>
      <Link className="pub-start-guide" to="/docs/quickstart">{c.quickStart} <ArrowRight size={15} /></Link>
    </div>
    <aside className="pub-start-trust" aria-labelledby="trust-title">
      <div className="eyebrow">{c.deploymentEyebrow}</div>
      <h2 id="trust-title">{c.deploymentTitle}</h2>
      <p>{c.deploymentBody}</p>
      <div className="pub-start-choice"><Globe2 size={18} /><div><strong>{c.cloud}</strong><span>{c.cloudBody}</span></div><Link to="/docs/cloud" aria-label={c.cloudLabel}><ArrowRight size={15} /></Link></div>
      <div className="pub-start-choice"><Server size={18} /><div><strong>{c.selfHosted}</strong><span>{c.selfHostedBody}</span></div><Link to="/docs/self-hosting" aria-label={c.selfHostedLabel}><ArrowRight size={15} /></Link></div>
      <Link className="pub-start-security" to="/docs/security">{c.securityDetails} <ArrowRight size={15} /></Link>
    </aside>
  </section>;
}

export function LandingScreen() {
  const { language, copy } = usePublicI18n();
  const c = copy.landing;
  useEffect(() => { document.title = c.pageTitle; }, [c.pageTitle, language]);
  return <div className="pub-page"><PublicHeader /><main id="main-content">
    <section className="pub-hero teams-hero" aria-labelledby="hero-title"><div className="pub-hero-copy"><div className="eyebrow">{c.heroEyebrow}</div><h1 id="hero-title" className={`pub-fleet-title${language === 'zh-Hans' ? ' is-zh' : ''}`}>{c.heroTitleA}<br /><span>{c.heroTitleB}<br />{c.heroTitleC}</span></h1><p>{c.heroBody}</p><div className="pub-hero-thesis mono"><span>{c.thesisA}</span><strong>{c.thesisB}</strong></div><div className="pub-actions"><a className="pub-button is-primary" href={`${import.meta.env.BASE_URL}login`}>{c.primaryCta} <ArrowRight size={16} /></a><Link className="pub-button" to="/docs/agent-teams">{c.secondaryCta}</Link></div><div className="pub-meta mono"><span>{c.metaWeb}</span><span>{c.metaChoice}</span><span>{c.metaHost}</span></div></div><TeamsDiagram /></section>
    <TeamsStory />
    <ProductShowcase />
    <RuntimeArchitectureProof />
    <RegionalRelayProof />
    <WhyVeryHappy />
    <StartAndTrust />
    <MobileContinuityProof />
    <CoreFeatureProofs />
    <KeyboardWorkflowProof compact />
    <section className="pub-final"><div><div className="eyebrow">{c.finalEyebrow}</div><h2>{c.finalTitleA}<br /><span>{c.finalTitleB}</span></h2><p>{c.finalBody}</p></div><div className="pub-actions"><a className="pub-button is-primary" href={`${import.meta.env.BASE_URL}login`}>{c.primaryCta} <ArrowRight size={16} /></a><a className="pub-button" href={GITHUB_URL}><Github size={16} /> {c.viewSource}</a></div></section>
  </main><PublicFooter /></div>;
}
