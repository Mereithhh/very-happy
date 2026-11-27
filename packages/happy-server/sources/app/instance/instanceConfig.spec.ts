import { describe, expect, it } from 'vitest';
import { createInstanceConfigSource, parseInstanceConfig } from './instanceConfig';

describe('parseInstanceConfig', () => {
    it('expands ${ENV} references and reports unset ones by name only', () => {
        const { config, problems } = parseInstanceConfig(JSON.stringify({
            modelFeedback: { forward: { url: 'https://c.example.com/x', headers: { Authorization: 'Bearer ${TOK}', 'X-Other': '${MISSING_ONE}' } } },
        }), { TOK: 'abc' });
        expect(config.modelFeedback?.forward?.headers).toEqual({ Authorization: 'Bearer abc', 'X-Other': '' });
        expect(config.modelFeedback).toMatchObject({ enabled: true, scope: 'tagged' });
        expect(problems).toEqual(['unset environment variables: MISSING_ONE']);
    });

    it('one broken section does not switch the others off', () => {
        const { config, problems } = parseInstanceConfig(JSON.stringify({
            modelRequestTagging: { sessionHeader: 'bad header', requestHeader: 'X-R' },
            modelFeedback: { enabled: true },
        }), {});
        expect(config.modelRequestTagging).toBeNull();
        expect(config.modelFeedback).toMatchObject({ enabled: true });
        expect(problems[0]).toMatch(/^modelRequestTagging: sessionHeader/);
    });

    it('non-JSON or non-object is everything off', () => {
        expect(parseInstanceConfig('{').config.modelFeedback).toBeNull();
        expect(parseInstanceConfig('[]').problems).toEqual(['top level must be an object']);
    });
});

describe('createInstanceConfigSource', () => {
    it('serves the empty config without a file and on a missing file', () => {
        expect(createInstanceConfigSource({})().modelFeedback).toBeNull();
        const warnings: string[] = [];
        expect(createInstanceConfigSource({ file: '/nonexistent/x.json', warn: w => warnings.push(w) })().modelFeedback).toBeNull();
        expect(warnings).toHaveLength(1);
    });
});
