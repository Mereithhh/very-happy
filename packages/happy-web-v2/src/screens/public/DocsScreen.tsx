import { ArrowLeft, ArrowRight, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { PublicFooter, PublicHeader } from './PublicShell';
import { getPublicDoc, PUBLIC_DOCS } from './publicContent';
import './public.css';

function DocNav({ onNavigate }: { onNavigate?: () => void }) {
  return <nav className="docs-nav" aria-label="Documentation chapters">{PUBLIC_DOCS.map((doc) => <NavLink key={doc.slug} to={`/docs/${doc.slug}`} onClick={onNavigate}>{doc.label}</NavLink>)}</nav>;
}

export function DocsScreen() {
  const { slug } = useParams();
  const [menuOpen, setMenuOpen] = useState(false);
  const doc = getPublicDoc(slug);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    setMenuOpen(false);
    document.title = doc ? `${doc.label} — Very Happy Docs` : slug ? 'Not found — Very Happy Docs' : 'Documentation — Very Happy';
  }, [doc, slug]);

  if (slug && !doc) {
    return <div className="pub-page"><PublicHeader /><main id="main-content" className="docs-missing"><div className="eyebrow">404 // DOC NOT FOUND</div><h1>That chapter is not here.</h1><p>The documentation may have moved.</p><Link className="pub-button" to="/docs"><ArrowLeft size={15} /> Documentation home</Link></main><PublicFooter /></div>;
  }

  return (
    <div className="pub-page docs-page">
      <PublicHeader />
      <div className="docs-mobile-bar"><strong>Documentation</strong><button type="button" aria-expanded={menuOpen} aria-controls="docs-navigation" onClick={() => setMenuOpen((v) => !v)}>{menuOpen ? <X /> : <Menu />}<span className="sr-only">Toggle chapters</span></button></div>
      <main id="main-content" className="docs-layout">
        <aside id="docs-navigation" className={menuOpen ? 'is-open' : ''}><div className="eyebrow">DOCUMENTATION</div><DocNav onNavigate={() => setMenuOpen(false)} /><div className="docs-aside-note">Very Happy uses a trusted relay. <Link to="/docs/security">Understand the boundary.</Link></div></aside>
        {doc ? <DocArticle doc={doc} /> : <DocsIndex />}
      </main>
      <PublicFooter />
    </div>
  );
}

function DocsIndex() {
  return <article className="docs-article docs-index"><div className="eyebrow">START HERE</div><h1>Very Happy documentation</h1><p className="docs-lead">Everything you need to connect a machine, choose a relay, understand the security boundary, and operate Very Happy.</p><div className="docs-cards">{PUBLIC_DOCS.map((doc) => <Link key={doc.slug} to={`/docs/${doc.slug}`}><h2>{doc.label}</h2><p>{doc.summary}</p><span>Open chapter <ArrowRight size={14} /></span></Link>)}</div></article>;
}

function DocArticle({ doc }: { doc: NonNullable<ReturnType<typeof getPublicDoc>> }) {
  const index = PUBLIC_DOCS.indexOf(doc);
  const previous = PUBLIC_DOCS[index - 1];
  const next = PUBLIC_DOCS[index + 1];
  return <article className="docs-article"><div className="eyebrow">GUIDE // {String(index + 1).padStart(2, '0')}</div><h1>{doc.label}</h1><p className="docs-lead">{doc.summary}</p>{doc.sections.map((section) => <section key={section.heading}><h2>{section.heading}</h2>{section.blocks.map((block, blockIndex) => {
    if (block.type === 'p') return <p key={blockIndex}>{block.text}</p>;
    if (block.type === 'code') return <pre key={blockIndex}><code>{block.code}</code></pre>;
    if (block.type === 'list') return <ul key={blockIndex}>{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;
    if (block.type === 'link') return <p key={blockIndex}><a href={block.href} target="_blank" rel="noreferrer">{block.label}</a></p>;
    return <div className="docs-note" key={blockIndex}>{block.text}</div>;
  })}</section>)}<nav className="docs-pager" aria-label="Adjacent chapters">{previous ? <Link to={`/docs/${previous.slug}`}><ArrowLeft size={14} />{previous.label}</Link> : <span />}{next && <Link to={`/docs/${next.slug}`}>{next.label}<ArrowRight size={14} /></Link>}</nav></article>;
}
