import { OrbitLoader } from '@/ui';

const pageStyle = {
  minHeight: '100dvh',
  display: 'grid',
  placeItems: 'center',
  padding: 'var(--sp-6)',
  background: 'var(--bg-0)',
} as const;

const gridStyle = {
  width: 'min(760px, 100%)',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 'var(--sp-5)',
} as const;

const panelStyle = {
  minHeight: 360,
  display: 'grid',
  placeItems: 'center',
  padding: 'var(--sp-6)',
  background: 'var(--bg-1)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-lg)',
} as const;

export function OrbitLoaderHarness() {
  return (
    <main style={pageStyle}>
      <div style={gridStyle}>
        <section style={panelStyle} aria-label="Session loading preview">
          <OrbitLoader size="compact" label="正在加载消息…" />
        </section>
        <section style={panelStyle} aria-label="About preview">
          <OrbitLoader size="medium" label={`版本 ${__APP_VERSION__}`} showWordmark presentation />
        </section>
      </div>
    </main>
  );
}
