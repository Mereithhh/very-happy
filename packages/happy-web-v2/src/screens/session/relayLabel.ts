import type { MachineRelayStatus } from '@/sync/apiSocket';

export function relayRegionLabel(status: MachineRelayStatus, serverUrl: string): string {
  if (status.transport === 'regional' && status.state === 'connected') {
    return shortRegion(status.region || status.relayId || 'Relay');
  }
  try {
    const host = new URL(serverUrl, globalThis.location?.origin).hostname.toLowerCase();
    if (host === 'veryhappy.dev' || host.endsWith('.veryhappy.dev')) return '🇸🇬 SG';
  } catch { /* honest generic fallback */ }
  return 'ORIGIN';
}

function shortRegion(region: string): string {
  if (/^(singapore|sg)$/i.test(region)) return '🇸🇬 SG';
  if (/^(us west|us-west|usa? west)$/i.test(region)) return '🇺🇸 US WEST';
  return region.toUpperCase();
}
