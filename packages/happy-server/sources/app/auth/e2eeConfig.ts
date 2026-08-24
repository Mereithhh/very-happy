export interface E2eeSignupConfig {
    enabled: boolean;
    required: boolean;
}

function explicitBoolean(name: string, value: string | undefined): boolean {
    if (value === undefined || value === '' || value === '0' || value === 'false') return false;
    if (value === '1' || value === 'true') return true;
    throw new Error(`${name} must be true, false, 1, 0, or unset`);
}

export function resolveE2eeSignupConfig(env: NodeJS.ProcessEnv = process.env): E2eeSignupConfig {
    const enabled = explicitBoolean('E2EE_SIGNUP_ENABLED', env.E2EE_SIGNUP_ENABLED?.trim().toLowerCase());
    const required = explicitBoolean('E2EE_SIGNUP_REQUIRED', env.E2EE_SIGNUP_REQUIRED?.trim().toLowerCase());
    if (required && !enabled) {
        throw new Error('E2EE_SIGNUP_REQUIRED=true requires E2EE_SIGNUP_ENABLED=true');
    }
    return { enabled, required };
}
