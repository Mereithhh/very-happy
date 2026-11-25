/**
 * B-974d (DESIGN B-973 §4.1, §5.3 bodyMd, T6): restricted markdown for plugin
 * cards. Raw HTML is never rendered (react-markdown skips it), images render as
 * their alt text, only http(s)/mailto links survive, every link shows its full
 * host and opens only after the host confirm with the complete URL.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { pluginLinkTarget } from './pluginLinks';

export function PluginMarkdown({ text }: { text: string }) {
  const { t } = useTranslation();
  const components: Components = {
    img: ({ alt }) => <span className="plg-md-img">{alt ? `[${alt}]` : '[image]'}</span>,
    a: ({ href, children }) => {
      const target = pluginLinkTarget(href);
      if (!target) return <span>{children}</span>;
      return (
        <a
          href={target.url}
          className="plg-md-link"
          rel="noopener noreferrer nofollow"
          onClick={(e) => {
            e.preventDefault();
            void Modal.confirm(t('plugins.decision.linkTitle'), target.url, { confirmText: t('plugins.panel.open') }).then((ok) => {
              if (ok) window.open(target.url, '_blank', 'noopener,noreferrer');
            });
          }}
        >
          {children}
          <span className="plg-md-host"> ({target.host})</span>
        </a>
      );
    },
  };
  return (
    <div className="plg-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components} urlTransform={(u) => (pluginLinkTarget(u) ? u : '')}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
