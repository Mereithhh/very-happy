import { OrbitLoader } from '@/ui/OrbitLoader';

export function RouteLoading({ fullViewport = false }: { fullViewport?: boolean }) {
  return (
    <div
      aria-busy="true"
      style={{
        flex: 1,
        width: '100%',
        height: fullViewport ? '100dvh' : undefined,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <OrbitLoader size="compact" label="Loading workspace" />
    </div>
  );
}
