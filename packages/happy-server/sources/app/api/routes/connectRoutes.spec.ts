import { describe, expect, it } from 'vitest';
import { buildGithubAuthorizeUrl, resolveGithubWebappUrl } from './connectRoutes';

describe('GitHub connect OAuth contract', () => {
    it('requests only the profile scope used by the callback', () => {
        const url = new URL(buildGithubAuthorizeUrl('client', 'https://relay.example/callback', 'state'));
        expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
        expect(url.searchParams.get('scope')).toBe('read:user');
        expect(url.searchParams.get('scope')).not.toMatch(/codespace|read:org|user:email|repo/);
    });

    it('normalizes a configured HTTPS web origin', () => {
        const oldPublic = process.env.PUBLIC_WEBAPP_URL;
        const oldHappy = process.env.HAPPY_WEB_URL;
        process.env.PUBLIC_WEBAPP_URL = 'https://relay.example/app';
        delete process.env.HAPPY_WEB_URL;
        expect(resolveGithubWebappUrl()).toBe('https://relay.example/');
        if (oldPublic === undefined) delete process.env.PUBLIC_WEBAPP_URL;
        else process.env.PUBLIC_WEBAPP_URL = oldPublic;
        if (oldHappy === undefined) delete process.env.HAPPY_WEB_URL;
        else process.env.HAPPY_WEB_URL = oldHappy;
    });
});
