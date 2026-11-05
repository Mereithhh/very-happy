/**
 * B-892 clickable prototype: the REAL <Sidebar/>, <CommandPalette/> and Issues
 * screens over seeded stores, plus a switch bar. In-memory router, in-page
 * issues fake, connect-src 'none': it cannot reach a server. Screens outside
 * this proposal show a placeholder.
 * Query: top=current|a1|a2|b · issues=0|1 · seed=owner|active|fresh · path=/issues · bar=0
 */
import { useEffect, useMemo, useState, lazy, Suspense, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useIsDesktop, useMediaQuery } from '@/app/useMediaQuery';
import { appShellMode, TOUCH_DRAWER_MQ } from '@/app/appShellMode';
import { useSidebarPrefs } from '@/app/useSidebarPrefs';
import { AppShell } from '@/screens/AppShell';
import '@/screens/layout.css';
import { Sidebar } from '@/screens/sessions/Sidebar';
import { EmptyDetail } from '@/screens/sessions/EmptyDetail';
import { CommandPalette } from '@/screens/command/CommandPalette';
import { useB892, type SidebarTopVariant } from '@/screens/sessions/sidebarTopVariant';
import { IssuesScreen } from '@/screens/issues/IssuesScreen';
import { IssueDetailScreen } from '@/screens/issues/IssueDetailScreen';
import { ProjectsListScreen } from '@/screens/projects/ProjectsListScreen';
import { seedPrototype, type SeedKind } from './seed';
import './prototype.css';

const params = new URLSearchParams(window.location.search);
const TOPS: { value: SidebarTopVariant; label: string }[] = [{ value: 'current', label: '现状' }, { value: 'a1', label: 'A1 图标条' }, { value: 'a2', label: 'A2 常用+更多' }, { value: 'b', label: 'B 底部栏' }];
const SEEDS: { value: SeedKind; label: string }[] = [{ value: 'owner', label: '仅已完成' }, { value: 'active', label: '有进行中' }, { value: 'fresh', label: '新账号' }];
const seedKind = (SEEDS.find((s) => s.value === params.get('seed'))?.value ?? 'owner') as SeedKind;
useB892.setState({
  top: TOPS.find((t) => t.value === params.get('top'))?.value ?? 'current',
  issues: params.get('issues') === '1',
});

function Placeholder({ title }: { title?: string }) {
  const { pathname } = useLocation();
  return <main className="b892-placeholder"><h1>{title ?? pathname}</h1><p>原型占位：这个页面不在 B-892 改动范围内，点侧栏入口只验证导航可达。</p></main>;
}

function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const desktop = useIsDesktop();
  const touchDrawer = useMediaQuery(TOUCH_DRAWER_MQ);
  const { width, collapsed, setWidth } = useSidebarPrefs();
  const mode = appShellMode({ settings: false, desktop, touchDrawer, collapsed, atRoot: location.pathname === '/', firstRun: false, workspaceGuide: false });
  return (
    <AppShell mode={mode} width={width} parked={false} sidebar={<Sidebar />}
      rail={<button className="app-rail-btn" onClick={() => useSidebarPrefs.getState().setCollapsed(false)} aria-label="展开侧栏">☰</button>} notes={null}
      onResizeStart={(e) => {
        e.preventDefault();
        const move = (m: MouseEvent) => setWidth(Math.max(240, Math.min(520, m.clientX)));
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}>
      {children}
    </AppShell>
  );
}

function SwitchBar() {
  const { top, issues, set } = useB892();
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(params.get('bar') === '0');
  const reseed = (seed: SeedKind) => {
    const q = new URLSearchParams(window.location.search);
    q.set('seed', seed); q.set('top', top); q.set('issues', issues ? '1' : '0'); q.set('path', '/issues');
    window.location.search = q.toString();
  };
  if (hidden) return null;
  return (
    <div className="b892-bar" role="group" aria-label="原型开关" data-testid="b892-bar">
      <span className="b892-bar-group">
        <b>侧栏</b>
        {TOPS.map((t) => <button key={t.value} type="button" aria-pressed={top === t.value} data-top={t.value} onClick={() => set({ top: t.value })}>{t.label}</button>)}
      </span>
      <span className="b892-bar-group">
        <b>Issues</b>
        <button type="button" aria-pressed={!issues} data-issues="0" onClick={() => { set({ issues: false }); navigate('/issues'); }}>现状</button>
        <button type="button" aria-pressed={issues} data-issues="1" onClick={() => { set({ issues: true }); navigate('/issues'); }}>改进</button>
      </span>
      <span className="b892-bar-group">
        <b>数据</b>
        {SEEDS.map((s) => <button key={s.value} type="button" aria-pressed={seedKind === s.value} data-seed={s.value} onClick={() => reseed(s.value)}>{s.label}</button>)}
      </span>
      <button type="button" className="b892-bar-hide" aria-label="隐藏开关条" onClick={() => setHidden(true)}>×</button>
    </div>
  );
}

const ExternalTodos = lazy(() => import('@/screens/issues/ExternalTodosRoute').then((m) => ({ default: m.ExternalTodosRoute })));

export function PrototypeApp() {
  const [ready, setReady] = useState(false);
  const initial = useMemo(() => [params.get('path') ?? '/'], []);
  useEffect(() => { const stop = seedPrototype(seedKind); setReady(true); return stop; }, []);
  if (!ready) return null;
  return (
    <MemoryRouter initialEntries={initial}>
      <Shell>
        <Routes>
          <Route path="/" element={<EmptyDetail />} />
          <Route path="/issues" element={<IssuesScreen />} />
          <Route path="/issues/external" element={<Suspense fallback={null}><ExternalTodos /></Suspense>} />
          <Route path="/issues/:key" element={<IssueDetailScreen />} />
          <Route path="/projects" element={<ProjectsListScreen />} />
          <Route path="/board" element={<Placeholder title="运行中" />} />
          <Route path="/teams" element={<Placeholder title="团队" />} />
          <Route path="/automations" element={<Placeholder title="自动化" />} />
          <Route path="/people" element={<Placeholder title="联系人" />} />
          <Route path="*" element={<Placeholder />} />
        </Routes>
      </Shell>
      <CommandPalette />
      <SwitchBar />
    </MemoryRouter>
  );
}
