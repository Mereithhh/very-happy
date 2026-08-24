export type LocalMachineIdentityStatus = {
    configured: boolean;
    label: string;
    nextStep?: string;
};

/**
 * A machineId in settings proves only local identity configuration. It does
 * not prove that the configured relay currently has the machine registered.
 */
export function localMachineIdentityStatus(machineId: string | undefined): LocalMachineIdentityStatus {
    if (machineId) {
        return {
            configured: true,
            label: 'Local machine identity configured (relay registration not checked)',
        };
    }
    return {
        configured: false,
        label: 'Local machine identity missing',
        nextStep: 'Run "very-happy auth login --force" to create and register one',
    };
}
