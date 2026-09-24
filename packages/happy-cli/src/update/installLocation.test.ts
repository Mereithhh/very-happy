import { describe, it, expect } from 'vitest';
import { globalPrefixForPackage, installLocationWarnings, packageDirForBin } from './installLocation';

describe('B-489 install location', () => {
    it('derives the prefix only from the standard global layout', () => {
        expect(globalPrefixForPackage('/home/sagemaker-user/.local/lib/node_modules/very-happy-cli')).toBe('/home/sagemaker-user/.local');
        expect(globalPrefixForPackage('/opt/homebrew/lib/node_modules/very-happy-cli')).toBe('/opt/homebrew');
        expect(globalPrefixForPackage('/repo/packages/happy-cli')).toBeNull();
        expect(globalPrefixForPackage('/lib/node_modules/very-happy-cli')).toBeNull();
        expect(globalPrefixForPackage('/home/a b/lib/node_modules/very-happy-cli')).toBeNull();
        expect(globalPrefixForPackage('relative/lib/node_modules/very-happy-cli')).toBeNull();
    });

    it('maps a real bin path back to its package', () => {
        expect(packageDirForBin('/opt/conda/lib/node_modules/very-happy-cli/bin/very-happy.mjs')).toBe('/opt/conda/lib/node_modules/very-happy-cli');
        expect(packageDirForBin('/usr/local/bin/very-happy')).toBeNull();
    });

    it('explains the SageMaker case: two installs and npm -g pointing at the other one', () => {
        const warnings = installLocationWarnings({
            runningPackageDir: '/home/sagemaker-user/.local/lib/node_modules/very-happy-cli',
            onPath: [
                '/home/sagemaker-user/.local/lib/node_modules/very-happy-cli/bin/very-happy.mjs',
                '/opt/conda/lib/node_modules/very-happy-cli/bin/very-happy.mjs',
            ],
            npmGlobalPrefix: '/opt/conda',
        }, '0.2.149');
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain('Found 2 very-happy installs');
        expect(warnings[1]).toContain('npm install -g --prefix /home/sagemaker-user/.local --allow-scripts=very-happy-cli,node-pty very-happy-cli@0.2.149 && very-happy daemon start');
    });

    it('is silent for a single, consistent install', () => {
        expect(installLocationWarnings({
            runningPackageDir: '/opt/homebrew/lib/node_modules/very-happy-cli',
            onPath: ['/opt/homebrew/lib/node_modules/very-happy-cli/bin/very-happy.mjs'],
            npmGlobalPrefix: '/opt/homebrew',
        })).toEqual([]);
    });

    it('flags a shell command that resolves to a different copy than this CLI', () => {
        const warnings = installLocationWarnings({
            runningPackageDir: '/home/u/.local/lib/node_modules/very-happy-cli',
            onPath: ['/opt/conda/lib/node_modules/very-happy-cli/bin/very-happy.mjs'],
            npmGlobalPrefix: null,
        });
        expect(warnings).toEqual(['The very-happy command runs /opt/conda/lib/node_modules/very-happy-cli, but this CLI runs from /home/u/.local/lib/node_modules/very-happy-cli.']);
    });
});
