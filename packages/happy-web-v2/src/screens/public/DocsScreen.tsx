import { ArrowLeft, ArrowRight, BookOpen, Menu, TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { PublicFooter, PublicHeader } from './PublicShell';
import { ProductWorkspacePreview } from './ProductWorkspacePreview';
import { getPublicDoc, PUBLIC_DOCS } from './publicContent';
import './public.css';

function DocNav({ onNavigate }: { onNavigate?: () => void }) {
  return <nav className="docs-nav" aria-label="Documentation chapters">{PUBLIC_DOCS.map((doc) => <NavLink key={doc.slug} to={`/docs/${doc.slug}`} onClick={onNavigate}>{doc.label}</NavLink>)}</nav>;
}

const DOC_GROUPS = [
  { label: 'Start', slugs: ['quickstart', 'cli', 'cloud', 'self-hosting'] },
  { label: 'Understand', slugs: ['architecture', 'security'] },
  { label: 'Operate', slugs: ['configuration', 'accounts-and-quotas', 'upgrades', 'troubleshooting'] },
  { label: 'Extend', slugs: ['integrations', 'contributing'] },
];

function sectionId(heading: string) {
  return `section-${heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
}

export function DocsScreen() {
  const { slug } = useParams();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const doc = getPublicDoc(slug);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    setMenuOpen(false);
    document.title = doc ? `${doc.label} — Very Happy Docs` : slug ? 'Not found — Very Happy Docs' : 'Documentation — Very Happy';
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.docs-article h1')?.focus({ preventScroll: true }));
  }, [doc, slug]);
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
    return <div className="pub-page"><PublicHeader /><main id="main-content" className="docs-missing"><div className="eyebrow">404 // DOC NOT FOUND</div><h1>That chapter is not here.</h1><p>The documentation may have moved.</p><Link className="pub-button" to="/docs"><ArrowLeft size={15} /> Documentation home</Link></main><PublicFooter /></div>;
  }

  return (
    <div className="pub-page docs-page">
      <PublicHeader />
      <div className="docs-mobile-bar"><strong>Documentation</strong><button ref={menuButtonRef} type="button" aria-expanded={menuOpen} aria-controls="docs-navigation" onClick={() => setMenuOpen((v) => !v)}>{menuOpen ? <X /> : <Menu />}<span className="sr-only">Toggle chapters</span></button></div>
      <main id="main-content" className="docs-layout">
        <aside id="docs-navigation" className={menuOpen ? 'is-open' : ''}><div className="eyebrow">DOCUMENTATION</div><DocNav onNavigate={() => setMenuOpen(false)} /><div className="docs-aside-note">Very Happy uses a trusted relay. <Link to="/docs/security">Understand the boundary.</Link></div></aside>
        {doc ? <><DocArticle doc={doc} /><nav className="docs-toc" aria-label="On this page"><span>ON THIS PAGE</span>{doc.sections.map((section) => <a key={section.heading} href={`#${sectionId(section.heading)}`}>{section.heading}</a>)}</nav></> : <DocsIndex />}
      </main>
      <PublicFooter />
    </div>
  );
}

function DocsIndex() {
  return <article className="docs-article docs-index"><div className="docs-index-hero"><div><div className="eyebrow">THE FIELD MANUAL</div><h1 tabIndex={-1}>Build from anywhere.<br />Operate with clarity.</h1><p className="docs-lead">Connect a machine, choose an agent, understand the trusted relay, and keep the system healthy.</p></div><div className="docs-index-stat"><BookOpen size={20} aria-hidden="true" /><strong>{PUBLIC_DOCS.length}</strong><span>FOCUSED GUIDES · ONE TRUST MODEL</span></div></div><section className="docs-product-proof" aria-labelledby="docs-product-proof-title"><div className="eyebrow">THE INTERFACE IN THIS GUIDE</div><h2 id="docs-product-proof-title">Learn the product you will actually use.</h2><p>The interface below uses the authenticated app's production component styles and Console tokens with sanitized fixture data.</p><ProductWorkspacePreview compact /></section>{DOC_GROUPS.map((group) => <section key={group.label}><div className="eyebrow">{group.label.toUpperCase()}</div><div className="docs-cards">{group.slugs.map((slug, index) => { const doc = PUBLIC_DOCS.find((candidate) => candidate.slug === slug)!; return <Link key={doc.slug} to={`/docs/${doc.slug}`}><span className="docs-card-number">{String(index + 1).padStart(2, '0')} / {group.label.toUpperCase()}</span><h2>{doc.label}</h2><p>{doc.summary}</p><span>Open guide <ArrowRight size={14} /></span></Link>; })}</div></section>)}</article>;
}

function DocArticle({ doc }: { doc: NonNullable<ReturnType<typeof getPublicDoc>> }) {
  const index = PUBLIC_DOCS.indexOf(doc);
  const previous = PUBLIC_DOCS[index - 1];
  const next = PUBLIC_DOCS[index + 1];
  return <article className="docs-article"><header className="docs-article-header"><div className="eyebrow">FIELD GUIDE // {String(index + 1).padStart(2, '0')}</div><h1 tabIndex={-1}>{doc.label}</h1><p className="docs-lead">{doc.summary}</p></header>{doc.sections.map((section) => <section id={sectionId(section.heading)} key={section.heading}><h2>{section.heading}</h2>{section.blocks.map((block, blockIndex) => {
    if (block.type === 'p') return <p key={blockIndex}>{block.text}</p>;
    if (block.type === 'code') return <pre key={blockIndex}><code>{block.code}</code></pre>;
    if (block.type === 'list') return <ul key={blockIndex}>{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;
    if (block.type === 'link') return <p key={blockIndex}><a href={block.href} target="_blank" rel="noreferrer">{block.label}</a></p>;
    return <div className="docs-note" key={blockIndex}>{block.text}</div>;
  })}</section>)}<nav className="docs-pager" aria-label="Adjacent chapters">{previous ? <Link to={`/docs/${previous.slug}`}><ArrowLeft size={14} />{previous.label}</Link> : <span />}{next && <Link to={`/docs/${next.slug}`}>{next.label}<ArrowRight size={14} /></Link>}</nav><div className="docs-end-mark"><TerminalSquare size={15} aria-hidden="true" /> Keep the thread.</div></article>;
}
