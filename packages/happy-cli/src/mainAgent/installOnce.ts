import { authenticatedAutomationsClient } from '@/automations/client'
import { assistantHome } from '@/assistant/bootstrap'
import { httpKvIo } from '@/assistant/mainAgentPointer'
import { configuration } from '@/configuration'
import { readCredentialsForConfiguredRelay } from '@/persistence'
import { ensureDefaultAutomations, machineZone, writeDefaultQuietHours } from './defaultAutomations'

/** B-924: daemon hook — once per machine (marker in the assistant home): the main agent's default automations and default quiet hours. */
export async function installMainAgentDefaultsOnce(machineId: string): Promise<string[] | null> {
    const { client } = await authenticatedAutomationsClient('daemon-main-agent')
    const tz = machineZone()
    const created = await ensureDefaultAutomations(client, { machineId, tz, assistantHome: assistantHome() })
    if (created !== null) {
        const credentials = await readCredentialsForConfiguredRelay()
        if (credentials) await writeDefaultQuietHours(httpKvIo(configuration.serverUrl, () => credentials.token), tz).catch(() => undefined)
    }
    return created
}
