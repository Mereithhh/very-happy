import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scryptAsync(password, salt, 64) as Buffer;
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    try {
        const parts = stored.split('$');
        if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
        if (!/^[a-f0-9]{32}$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) return false;
        const salt = Buffer.from(parts[1], 'hex');
        const expected = Buffer.from(parts[2], 'hex');
        const derived = await scryptAsync(password, salt, expected.length) as Buffer;
        return expected.length === derived.length && timingSafeEqual(expected, derived);
    } catch {
        return false;
    }
}

export async function burnMissingPasswordLookup(password: string): Promise<void> {
    await scryptAsync(password, Buffer.alloc(16), 64);
}
