import { StartupLoader } from '@/ui/StartupLoader';

export function RouteLoading({
  fullViewport = false,
  label = 'Loading workspace',
}: {
  fullViewport?: boolean;
  label?: string;
}) {
  return (
    <div
      className="vh-route-loading"
      aria-busy="true"
      data-vh-route-loading="true"
      style={{
        flex: fullViewport ? undefined : 1,
        position: fullViewport ? 'fixed' : undefined,
        inset: fullViewport ? 0 : undefined,
        zIndex: fullViewport ? 20 : undefined,
        width: fullViewport ? '100vw' : '100%',
        height: fullViewport ? '100dvh' : undefined,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {fullViewport ? <StartupLoader label={label}/> : <div className="vh-route-skeleton">
        <div className="vh-startup-caption" role="status" aria-label={label}><span className="vh-startup-dot" aria-hidden="true"/>{label}</div>
        {[0,1,2,3].map(line=><div key={line} className="vh-route-skeleton-line" aria-hidden="true"/>)}
      </div>}
    </div>
  );
}
