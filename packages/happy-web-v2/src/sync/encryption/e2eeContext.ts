export function assertE2eeOrigin(origin: string): void {
    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        throw new Error('Invalid E2EE origin');
    }
    if (parsed.origin !== origin || parsed.username || parsed.password) {
        throw new Error('E2EE origin must be a canonical URL origin');
    }
    const localHttp = parsed.protocol === 'http:'
        && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
    if (parsed.protocol !== 'https:' && !localHttp) {
        throw new Error('E2EE origin must use HTTPS (except localhost)');
    }
}

export function assertE2eeAccountId(accountId: string): void {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(accountId)) throw new Error('Invalid E2EE account id');
}

export function assertE2eeDeviceId(deviceId: string): void {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(deviceId)) throw new Error('Invalid E2EE device id');
}

export function assertE2eeObjectId(objectId: string): void {
    if (objectId.length < 1 || objectId.length > 512 || /[\u0000-\u001f\u007f]/.test(objectId)) {
        throw new Error('Invalid E2EE object id');
    }
}

export function assertE2eeEpoch(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > 0x7fff_ffff) {
        throw new Error('Invalid E2EE epoch');
    }
}

