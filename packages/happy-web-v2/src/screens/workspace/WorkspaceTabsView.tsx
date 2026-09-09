import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ActionContextMenu, type MenuItemDef } from '@/ui/Menu';
import type { WorkspaceTab } from './workspaceTabModel';
import './workspaceTabs.css';

/** Shared tab chrome. Content and persistence remain owned by the host. */
export function WorkspaceTabsView({ zh, tabs, active, onSelect, onClose, onMove, onCloseOthers, actions }: {
  zh: boolean; tabs: WorkspaceTab[]; active: string | null;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onMove: (id: string, target: string) => void; onCloseOthers?: (id:string)=>void; actions?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const focus = (id: string) => {
    const button = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find(el => el.dataset.tabId === id);
    button?.focus();
  };
  useEffect(() => {
    const button = [...(root.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find(el => el.dataset.tabId === active);
    const tab = button?.closest<HTMLElement>('.workspace-tab');
    const strip = tab?.closest<HTMLElement>('.workspace-tabstrip');
    if (!tab || !strip) return;
    const item = tab.getBoundingClientRect();
    const viewport = strip.getBoundingClientRect();
    // Only reveal the tab horizontally. scrollIntoView also scrolls ancestors,
    // which jumps the public Landing to its embedded workspace on initial load.
    const offset = item.left < viewport.left || item.width > viewport.width
      ? item.left - viewport.left
      : Math.max(0, item.right - viewport.right);
    strip.scrollLeft += offset;
  }, [active]);
  return <div className="workspace-tabs" ref={root}>
    <div className="workspace-tabstrip" role="tablist" aria-label={zh ? '工作区标签' : 'Workspace tabs'}>
      {tabs.map((tab, index) => {
        const left = tabs.slice(0,index).reverse().find(t => t.movable !== false && t.group === tab.group);
        const right = tabs.slice(index+1).find(t => t.movable !== false && t.group === tab.group);
        const items: MenuItemDef[] = [
          { key: 'close', label: zh ? '关闭标签' : 'Close tab', icon: X, disabled: tab.closable === false, onSelect: () => onClose(tab.id) },
          { key: 'others', icon: X, label: zh ? '关闭其他标签' : 'Close other tabs', disabled: !tabs.some(t => t.id !== tab.id && t.closable !== false), onSelect: () => onCloseOthers ? onCloseOthers(tab.id) : tabs.filter(t => t.id !== tab.id && t.closable !== false).forEach(t => onClose(t.id)) },
        ];
        return <ActionContextMenu key={tab.id} items={items}><div className={`workspace-tab${active === tab.id ? ' is-active' : ''}${over === tab.id ? ' is-drop-target' : ''}`}
          draggable={tab.movable !== false} onDragStart={e => { dragging.current = tab.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tab.id); }}
          onDragOver={e => { if (dragging.current && tab.movable !== false && tabs.find(t=>t.id===dragging.current)?.group === tab.group) { e.preventDefault(); setOver(tab.id); } }}
          onDrop={e => { if (dragging.current && tab.movable !== false && tabs.find(t=>t.id===dragging.current)?.group === tab.group) { e.preventDefault(); onMove(dragging.current, tab.id); } dragging.current = null; setOver(null); }}
          onDragEnd={() => { dragging.current = null; setOver(null); }}>
          <button role="tab" aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} data-tab-id={tab.id}
            className="workspace-tab-label" title={tab.description ?? tab.title} onClick={() => onSelect(tab.id)}
            onKeyDown={e => {
              if (e.altKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                e.preventDefault();
                const target = e.key === 'ArrowLeft' ? left : right;
                if (tab.movable !== false && target) onMove(tab.id, target.id);
                return;
              }
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
              if (next !== null) { e.preventDefault(); onSelect(tabs[next].id); focus(tabs[next].id); }
              if (e.key === 'Delete' && tab.closable !== false) { e.preventDefault(); onClose(tab.id); const target = tabs[index + 1] ?? tabs[index - 1]; if (target) focus(target.id); }
            }}>{tab.title}</button>
          {tab.closable !== false && <button className="workspace-tab-close" aria-label={`${zh ? '关闭' : 'Close'} ${tab.title}`} onClick={() => onClose(tab.id)}><X size={12}/></button>}
        </div></ActionContextMenu>;
      })}
    </div>
    {actions && <div className="workspace-tab-actions">{actions}</div>}
  </div>;
}
