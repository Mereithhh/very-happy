import type { E2eeAuthCredentials } from './tokenStorage';
import { E2eeUnlockError } from './e2eeRuntime';

export interface E2eeLoginLifecycleDependencies {
    createSync: (credentials: E2eeAuthCredentials) => Promise<void>;
    persistCredentials: (credentials: E2eeAuthCredentials) => Promise<boolean>;
    lockSync: () => void;
}

/**
 * Validate an E2EE bearer against the local vault before persisting it.
 *
 * A genuinely new device has no local keys yet, so its public bearer may be
 * retained in the locked state while the user supplies a recovery code. All
 * other failures are authentication failures and must leave no new bearer on
 * disk.
 */
export async function establishE2eeLogin(
    credentials: E2eeAuthCredentials,
    dependencies: E2eeLoginLifecycleDependencies,
): Promise<'unlocked' | 'locked-needs-recovery'> {
    try {
        await dependencies.createSync(credentials);
    } catch (error) {
        dependencies.lockSync();
        if (!(error instanceof E2eeUnlockError) || error.code !== 'missing-local-keys') {
            throw error;
        }
        const persisted = await dependencies.persistCredentials(credentials);
        if (!persisted) throw new Error('Failed to save E2EE credentials');
        return 'locked-needs-recovery';
    }

    const persisted = await dependencies.persistCredentials(credentials);
    if (!persisted) {
        dependencies.lockSync();
        throw new Error('Failed to save E2EE credentials');
    }
    return 'unlocked';
}
