/**
 * B-548: precheck writes that stay safe against an older server.
 *
 * An older server's zod schema silently strips `precheck` from create/update
 * bodies — a create would then store an automation that runs its action
 * unconditionally, the opposite of what the user asked. A new server always
 * answers with a `precheck` key (null when none), so its absence identifies
 * the old server. Creates with a precheck are therefore made paused first and
 * only resumed once the echo proves the gate was stored; otherwise the
 * automation is deleted again and the caller gets a clear error.
 */
import type { Automation, AutomationCreate, AutomationUpdate } from '@slopus/happy-wire';
import type { AutomationsClient } from './client';

export const PRECHECK_UNSUPPORTED_SERVER_MESSAGE = 'This server does not support automation prechecks: it would drop the precheck and run the action every time. Upgrade the server, or create the automation without a precheck.';

export function serverStoresPrecheck(automation: Automation): boolean {
    return Object.prototype.hasOwnProperty.call(automation, 'precheck');
}

type CreateClient = Pick<AutomationsClient, 'create' | 'remove' | 'resume'>;
export async function createAutomationChecked(client: CreateClient, input: AutomationCreate): Promise<Automation> {
    if (!input.precheck) return client.create(input);
    const created = await client.create({ ...input, status: 'paused' });
    if (!serverStoresPrecheck(created)) {
        const removed = await client.remove(created.id).then(() => true, () => false);
        throw new Error(removed ? PRECHECK_UNSUPPORTED_SERVER_MESSAGE : `${PRECHECK_UNSUPPORTED_SERVER_MESSAGE} The automation "${created.name}" was left paused; delete it.`);
    }
    return input.status === 'paused' ? created : client.resume(created.id);
}

/** Old servers cannot hold a precheck, so a stripped one changed nothing about how the action runs — only report it. */
export async function updateAutomationChecked(client: Pick<AutomationsClient, 'update'>, id: string, input: AutomationUpdate): Promise<Automation> {
    const updated = await client.update(id, input);
    if (input.precheck && !serverStoresPrecheck(updated)) throw new Error(`${PRECHECK_UNSUPPORTED_SERVER_MESSAGE} (Other changes were saved.)`);
    return updated;
}
