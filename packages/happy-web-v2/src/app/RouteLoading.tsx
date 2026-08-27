import { OrbitLoader } from '@/ui/OrbitLoader';

export function RouteLoading({
  fullViewport = false,
  label = 'Loading workspace',
}: {
  fullViewport?: boolean;
  label?: string;
}) {
  return (
    <div
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
      <OrbitLoader size="medium" label={label} showWordmark />
    </div>
  );
}
