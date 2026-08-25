import { ArrowLeft, ArrowRight, BookOpen, Check, Copy, Menu, TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router-dom';
import { PublicFooter, PublicHeader } from './PublicShell';
import { KeyboardWorkflowProof } from './KeyboardWorkflowProof';
import { MobileContinuityProof } from './MobileContinuityProof';
import { ProductWorkspacePreview } from './ProductWorkspacePreview';
import { getPublicDocs, type PublicDoc } from './publicContent';
import { usePublicI18n } from '@/i18n/publicI18n';
import './public.css';

function DocNav({ docs, label, onNavigate }: { docs: PublicDoc[]; label: string; onNavigate?: () => void }) {
  return <nav className="docs-nav" aria-label={label}>{docs.map((doc) => <NavLink key={doc.slug} to={`/docs/${doc.slug}`} onClick={onNavigate}>{doc.label}</NavLink>)}</nav>;
}

const DOC_GROUPS = [
  { key: 'start' as const, slugs: ['quickstart', 'keyboard', 'cli', 'cloud', 'self-hosting'] },
  { key: 'understand' as const, slugs: ['architecture', 'security'] },
  { key: 'operate' as const, slugs: ['configuration', 'accounts-and-quotas', 'upgrades', 'troubleshooting'] },
  { key: 'extend' as const, slugs: ['integrations', 'contributing'] },
];

function sectionId(heading: string) {
  return `section-${heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
}

export function DocsScreen() {
  const { language, copy } = usePublicI18n();
  const docs = getPublicDocs(language);
  const { slug } = useParams();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const doc = docs.find((candidate) => candidate.slug === slug);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    setMenuOpen(false);
    document.title = doc ? `${doc.label} — Very Happy Docs` : slug ? copy.docs.notFoundTitle : copy.docs.pageTitle;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.docs-article h1')?.focus({ preventScroll: true });
      if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    });
  }, [copy.docs.notFoundTitle, copy.docs.pageTitle, doc, language, location.hash, slug]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  if (slug && !doc) {
    return <div className="pub-page"><PublicHeader /><main id="main-content" className="docs-missing"><div className="eyebrow">{copy.docs.missingEyebrow}</div><h1>{copy.docs.missingTitle}</h1><p>{copy.docs.missingBody}</p><Link className="pub-button" to="/docs"><ArrowLeft size={15} /> {copy.docs.home}</Link></main><PublicFooter /></div>;
  }

  if (!slug) return <Navigate replace to="/docs/architecture" />;

  return (
    <div className="pub-page docs-page">
      <PublicHeader />
      <div className="docs-mobile-bar"><strong>{copy.docs.mobileTitle}</strong><button ref={menuButtonRef} type="button" aria-expanded={menuOpen} aria-controls="docs-navigation" onClick={() => setMenuOpen((v) => !v)}>{menuOpen ? <X /> : <Menu />}<span className="sr-only">{copy.docs.toggle}</span></button></div>
      <main id="main-content" className="docs-layout">
        <aside id="docs-navigation" className={menuOpen ? 'is-open' : ''}><div className="eyebrow">{copy.docs.eyebrow}</div><DocNav docs={docs} label={copy.docs.chaptersLabel} onNavigate={() => setMenuOpen(false)} /><div className="docs-aside-note">{copy.docs.aside} <Link to="/docs/security">{copy.docs.asideLink}</Link></div></aside>
        {doc ? <><DocArticle doc={doc} docs={docs} fieldGuideLabel={copy.docs.fieldGuide} adjacentLabel={copy.docs.adjacent} endLabel={copy.docs.end} copyCodeLabel={copy.docs.copyCode} copiedLabel={copy.docs.copied} /><nav className="docs-toc" aria-label={copy.docs.onThisPage}><span>{copy.docs.onThisPage}</span>{doc.sections.map((section) => <a key={section.heading} href={`#${sectionId(section.heading)}`}>{section.heading}</a>)}</nav></> : <DocsIndex docs={docs} copy={copy.docs} />}
      </main>
      <PublicFooter />
    </div>
  );
}

function DocsIndex({ docs, copy }: { docs: PublicDoc[]; copy: ReturnType<typeof usePublicI18n>['copy']['docs'] }) {
  return <article className="docs-article docs-index"><div className="docs-index-hero"><div><div className="eyebrow">{copy.fieldManual}</div><h1 tabIndex={-1}>{copy.indexTitleA}<br />{copy.indexTitleB}</h1><p className="docs-lead">{copy.indexLead}</p></div><div className="docs-index-stat"><BookOpen size={20} aria-hidden="true" /><strong>{docs.length}</strong><span>{copy.guides}</span></div></div><section className="docs-product-proof" aria-labelledby="docs-product-proof-title"><div className="eyebrow">{copy.interfaceEyebrow}</div><h2 id="docs-product-proof-title">{copy.interfaceTitle}</h2><p>{copy.interfaceBody}</p><ProductWorkspacePreview compact /></section><KeyboardWorkflowProof compact /><MobileContinuityProof compact />{DOC_GROUPS.map((group) => { const groupLabel = copy.groups[group.key]; return <section key={group.key}><div className="eyebrow">{groupLabel}</div><div className="docs-cards">{group.slugs.map((slug, index) => { const doc = docs.find((candidate) => candidate.slug === slug)!; return <Link key={doc.slug} to={`/docs/${doc.slug}`}><span className="docs-card-number">{String(index + 1).padStart(2, '0')} / {groupLabel}</span><h2>{doc.label}</h2><p>{doc.summary}</p><span>{copy.openGuide} <ArrowRight size={14} /></span></Link>; })}</div></section>; })}</article>;
}

function CopyableCode({ code, copyLabel, copiedLabel }: { code: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = code;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copiedWithFallback = document.execCommand('copy');
      textarea.remove();
      if (!copiedWithFallback) return;
    }
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1800);
  };
  const label = copied ? copiedLabel : copyLabel;
  return <div className="docs-code"><pre><code>{code}</code></pre><button type="button" className={copied ? 'is-copied mono' : 'mono'} onClick={copyCode} aria-label={label}>{copied ? <Check size={13} /> : <Copy size={13} />}<span>{label}</span></button></div>;
}

function DocArticle({ doc, docs, fieldGuideLabel, adjacentLabel, endLabel, copyCodeLabel, copiedLabel }: { doc: PublicDoc; docs: PublicDoc[]; fieldGuideLabel: string; adjacentLabel: string; endLabel: string; copyCodeLabel: string; copiedLabel: string }) {
  const index = docs.indexOf(doc);
  const previous = docs[index - 1];
  const next = docs[index + 1];
  return <article className="docs-article"><header className="docs-article-header"><div className="eyebrow">{fieldGuideLabel} // {String(index + 1).padStart(2, '0')}</div><h1 tabIndex={-1}>{doc.label}</h1><p className="docs-lead">{doc.summary}</p></header>{doc.sections.map((section) => <section id={sectionId(section.heading)} key={section.heading}><h2>{section.heading}</h2>{section.blocks.map((block, blockIndex) => {
    if (block.type === 'p') return <p key={blockIndex}>{block.text}</p>;
    if (block.type === 'code') return <CopyableCode key={blockIndex} code={block.code} copyLabel={copyCodeLabel} copiedLabel={copiedLabel} />;
    if (block.type === 'list') return <ul key={blockIndex}>{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;
    if (block.type === 'link') return <p key={blockIndex}><a href={block.href} target="_blank" rel="noreferrer">{block.label}</a></p>;
    if (block.type === 'image') return <figure className="docs-diagram" key={blockIndex}><img src={block.src} alt={block.alt} loading="lazy" /><figcaption className="mono">{block.caption}</figcaption></figure>;
    return <div className="docs-note" key={blockIndex}>{block.text}</div>;
  })}</section>)}<nav className="docs-pager" aria-label={adjacentLabel}>{previous ? <Link to={`/docs/${previous.slug}`}><ArrowLeft size={14} />{previous.label}</Link> : <span />}{next && <Link to={`/docs/${next.slug}`}>{next.label}<ArrowRight size={14} /></Link>}</nav><div className="docs-end-mark"><TerminalSquare size={15} aria-hidden="true" /> {endLabel}</div></article>;
}
