import {
    E2EE_PROTOCOL_VERSION,
    E2EE_SUITE_V1,
    StoredE2eeEnvelopeV1Schema,
    StoredE2eeHeaderV1Schema,
    storedE2eeEnvelopeAad,
    type StoredE2eeEnvelopeV1,
    type StoredE2eeHeaderV1,
} from '@slopus/happy-wire';
import { deriveAccountDomainKey } from '@/auth/e2eeKeyHierarchy';
import { decryptE2eeAesGcm, encryptE2eeAesGcm } from './e2eeAesGcm';
import {
    decodeBase64UrlCanonical,
    encodeBase64UrlCanonical,
    secureRandomBytes,
    utf8,
    utf8String,
} from './e2eeEncoding';
import { assertE2eeAccountId, assertE2eeOrigin } from './e2eeContext';
import { jcsCanonicalize, parseCanonicalJcs } from './e2eeJcs';

export const E2EE_ACCOUNT_DOMAINS = ['settings', 'kv', 'notes', 'tasks'] as const;
export type E2eeAccountDomain = typeof E2EE_ACCOUNT_DOMAINS[number];

const MAX_ACCOUNT_ENVELOPE_BYTES = 4 * 1024 * 1024;

/** The Web account wrapper is exactly the frozen shared stored-envelope wire. */
export type AccountEnvelopeV1 = StoredE2eeEnvelopeV1;

export interface AccountEnvelopeContext {
    origin: string;
    accountId: string;
    epochSecret: Uint8Array;
}

function validateContext(context: AccountEnvelopeContext): void {
    assertE2eeOrigin(context.origin);
    assertE2eeAccountId(context.accountId);
    if (context.epochSecret.length !== 32) throw new Error('Epoch secret must be 32 bytes');
}

function validateEnvelope(value: unknown): AccountEnvelopeV1 {
    const envelope = StoredE2eeEnvelopeV1Schema.parse(value);
    if (!E2EE_ACCOUNT_DOMAINS.includes(envelope.domain as E2eeAccountDomain)) {
        throw new Error('Invalid account envelope domain');
    }
    decodeBase64UrlCanonical(envelope.ciphertext, {
        minBytes: 16,
        maxBytes: MAX_ACCOUNT_ENVELOPE_BYTES,
    });
    return envelope;
}

export function accountEnvelopeAad(input: StoredE2eeHeaderV1 | AccountEnvelopeV1): Uint8Array {
    return storedE2eeEnvelopeAad(input);
}

export async function encryptAccountEnvelopeBytes(input: AccountEnvelopeContext & {
    epoch: number;
    domain: E2eeAccountDomain;
    objectId: string;
    field: string;
    plaintext: Uint8Array;
    nonce?: Uint8Array;
}): Promise<AccountEnvelopeV1> {
    validateContext(input);
    if (!E2EE_ACCOUNT_DOMAINS.includes(input.domain)) throw new Error('Invalid account envelope domain');
    const nonce = input.nonce ?? secureRandomBytes(12);
    const header = StoredE2eeHeaderV1Schema.parse({
        v: E2EE_PROTOCOL_VERSION,
        suite: E2EE_SUITE_V1,
        origin: input.origin,
        accountId: input.accountId,
        epoch: input.epoch,
        domain: input.domain,
        objectId: input.objectId,
        field: input.field,
        nonce: encodeBase64UrlCanonical(nonce),
    });
    const key = await deriveAccountDomainKey(input.epochSecret, input.epoch, input.domain);
    try {
        const encrypted = await encryptE2eeAesGcm(
            key,
            input.plaintext,
            storedE2eeEnvelopeAad(header),
            nonce,
        );
        return validateEnvelope({ ...header, ciphertext: encrypted.ciphertext });
    } finally {
        key.fill(0);
    }
}

export async function decryptAccountEnvelopeBytes(input: AccountEnvelopeContext & {
    envelope: AccountEnvelopeV1;
    expectedDomain: E2eeAccountDomain;
    expectedObjectId: string;
    expectedField: string;
}): Promise<Uint8Array> {
    validateContext(input);
    const envelope = validateEnvelope(input.envelope);
    if (envelope.origin !== input.origin || envelope.accountId !== input.accountId) {
        throw new Error('Account envelope context does not match');
    }
    if (envelope.domain !== input.expectedDomain) {
        throw new Error('Account envelope domain does not match');
    }
    if (envelope.objectId !== input.expectedObjectId) {
        throw new Error('Account envelope object does not match');
    }
    if (envelope.field !== input.expectedField) {
        throw new Error('Account envelope field does not match');
    }
    const key = await deriveAccountDomainKey(
        input.epochSecret,
        envelope.epoch,
        envelope.domain as E2eeAccountDomain,
    );
    try {
        return await decryptE2eeAesGcm(key, envelope, storedE2eeEnvelopeAad(envelope));
    } finally {
        key.fill(0);
    }
}

export async function encryptAccountEnvelopeJson(input: AccountEnvelopeContext & {
    epoch: number;
    domain: E2eeAccountDomain;
    objectId: string;
    field: string;
    value: unknown;
    nonce?: Uint8Array;
}): Promise<AccountEnvelopeV1> {
    return encryptAccountEnvelopeBytes({ ...input, plaintext: utf8(jcsCanonicalize(input.value)) });
}

export async function decryptAccountEnvelopeJson(input: AccountEnvelopeContext & {
    envelope: AccountEnvelopeV1;
    expectedDomain: E2eeAccountDomain;
    expectedObjectId: string;
    expectedField: string;
}): Promise<unknown> {
    const plaintext = await decryptAccountEnvelopeBytes(input);
    try {
        return parseCanonicalJcs(utf8String(plaintext), MAX_ACCOUNT_ENVELOPE_BYTES);
    } finally {
        plaintext.fill(0);
    }
}

export function serializeAccountEnvelope(envelope: AccountEnvelopeV1): string {
    return jcsCanonicalize(validateEnvelope(envelope));
}

export function parseAccountEnvelope(serialized: string): AccountEnvelopeV1 {
    return validateEnvelope(parseCanonicalJcs(serialized, MAX_ACCOUNT_ENVELOPE_BYTES * 2));
}
