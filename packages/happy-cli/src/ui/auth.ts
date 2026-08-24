import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration } from "@/configuration";
import { randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { delay } from "@/utils/time";
import { writeCredentialsLegacy, readCredentials, updateSettings, Credentials, writeCredentialsDataKey } from "@/persistence";
import { generateWebAuthUrl } from "@/api/webAuth";
import { openBrowser } from "@/utils/browser";
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import { credentialRelayProblem } from './authRelay';

export async function doAuth(): Promise<Credentials | null> {
    console.clear();

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
    const claimSecret = encodeBase64Url(randomBytes(32));

    // Create a new authentication request
    try {
        if (process.env.DEBUG) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${configuration.serverUrl}/v1/auth/request`);
        }
        const createResponse = await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(keypair.publicKey),
            supportsV2: true,
            supportsClaimSecret: true,
            claimSecret,
            pairingAction: 'create',
        }, {
            headers: {
                'X-Happy-Client': `cli/${configuration.currentCliVersion}`
            }
        });
        if (createResponse.data?.protocolVersion !== 3 || createResponse.data?.claimSecretRequired !== true) {
            console.log('This server does not support secure CLI pairing. Upgrade the server before signing in.');
            return null;
        }
        if (process.env.DEBUG) {
            console.log(`[AUTH DEBUG] Auth request sent successfully`);
        }
    } catch {
        if (process.env.DEBUG) {
            console.log('[AUTH DEBUG] Failed to send secure auth request');
        }
        console.log('Failed to create authentication request, please try again later.');
        return null;
    }

    return await doWebAuth(keypair, claimSecret);
}

/**
 * Handle web authentication flow
 */
async function doWebAuth(keypair: tweetnacl.BoxKeyPair, claimSecret: string): Promise<Credentials | null> {
    console.clear();
    console.log('\nWeb Authentication\n');

    const webUrl = generateWebAuthUrl(keypair.publicKey);
    console.log('Opening your browser...');

    const browserOpened = await openBrowser(webUrl);

    if (browserOpened) {
        console.log('✓ Browser opened\n');
        console.log('Complete authentication in your browser window.');
    } else {
        console.log('Could not open browser automatically.');
    }

    // I changed this to always show the URL because we got a report from
    // someone running happy inside a devcontainer that they saw the
    // "Complete authentication in your browser window." but nothing opened.
    // https://github.com/slopus/happy/issues/19
    console.log('\nIf the browser did not open, please copy and paste this URL:');
    console.log(webUrl);
    console.log('');

    return await waitForAuthentication(keypair, claimSecret);
}

/**
 * Wait for authentication to complete and return credentials
 */
async function waitForAuthentication(keypair: tweetnacl.BoxKeyPair, claimSecret: string): Promise<Credentials | null> {
    process.stdout.write('Waiting for authentication');
    let dots = 0;
    let cancelled = false;

    // Handle Ctrl-C during waiting
    const handleInterrupt = () => {
        cancelled = true;
        console.log('\n\nAuthentication cancelled.');
        process.exit(0);
    };

    process.on('SIGINT', handleInterrupt);

    try {
        while (!cancelled) {
            try {
                const response = await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
                    publicKey: encodeBase64(keypair.publicKey),
                    supportsV2: true,
                    supportsClaimSecret: true,
                    claimSecret,
                    pairingAction: 'poll',
                }, {
                    headers: {
                        'X-Happy-Client': `cli/${configuration.currentCliVersion}`
                    }
                });
                if (response.data?.protocolVersion !== 3 || response.data?.claimSecretRequired !== true) {
                    console.log('\n\nThis server does not support secure CLI pairing. Upgrade the server before signing in.');
                    return null;
                }
                if (response.data.state === 'authorized') {
                    let token = response.data.token as string;
                    let r = decodeBase64(response.data.response);
                    let decrypted = decryptWithEphemeralKey(r, keypair.secretKey);
                    if (decrypted) {
                        if (decrypted.length === 32) {
                            const credentials = {
                                secret: decrypted,
                                token: token
                            }
                            await writeCredentialsLegacy(credentials);
                            console.log('\n\n✓ Authentication successful\n');
                            return {
                                encryption: {
                                    type: 'legacy',
                                    secret: decrypted
                                },
                                token: token
                            };
                        } else {
                            if (decrypted[0] === 0) {
                                const credentials = {
                                    publicKey: decrypted.slice(1, 33),
                                    machineKey: randomBytes(32),
                                    token: token
                                }
                                await writeCredentialsDataKey(credentials);
                                console.log('\n\n✓ Authentication successful\n');
                                return {
                                    encryption: {
                                        type: 'dataKey',
                                        publicKey: credentials.publicKey,
                                        machineKey: credentials.machineKey
                                    },
                                    token: token
                                };
                            } else {
                                console.log('\n\nFailed to decrypt response. Please try again.');
                                return null;
                            }
                        }
                    } else {
                        console.log('\n\nFailed to decrypt response. Please try again.');
                        return null;
                    }
                }
            } catch (error) {
                console.log('\n\nFailed to check authentication status. Please try again.');
                return null;
            }

            // Animate waiting dots
            process.stdout.write('\rWaiting for authentication' + '.'.repeat((dots % 3) + 1) + '   ');
            dots++;

            await delay(1000);
        }
    } finally {
        process.off('SIGINT', handleInterrupt);
    }

    return null;
}

export function decryptWithEphemeralKey(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    // Extract components from bundle: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
    const ephemeralPublicKey = encryptedBundle.slice(0, 32);
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength);

    const decrypted = tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    if (!decrypted) {
        return null;
    }

    return decrypted;
}


/**
 * Ensure authentication and machine setup
 * This replaces the onboarding flow and ensures everything is ready
 */
export async function authAndSetupMachineIfNeeded(): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    // Step 1: Handle authentication
    let credentials = await readCredentials();
    let newAuth = false;

    if (credentials) {
        const relayProblem = credentialRelayProblem(credentials.authServerUrl, configuration.serverUrl);
        if (relayProblem) {
            throw new Error(
                `${relayProblem} Use a separate HAPPY_HOME_DIR for this relay, ` +
                'or run `very-happy auth login --force` before starting an agent or daemon.'
            );
        }
    }

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth();
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
        newAuth = true;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }

    // Make sure we have a machine ID
    // Server machine entity will be created either by the daemon or by the CLI
    const settings = await updateSettings(async s => {
        if (newAuth || !s.machineId) {
            return {
                ...s,
                machineId: randomUUID()
            };
        }
        return s;
    });

    logger.debug(`[AUTH] Machine ID: ${settings.machineId}`);

    return { credentials, machineId: settings.machineId! };
}
