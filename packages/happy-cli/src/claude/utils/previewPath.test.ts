import { describe, expect, it } from 'vitest';
import { checkPreviewPath } from './previewPath';

const HOME = '/home/tester';
const CWD = '/home/tester/code/project';
const opts = { home: HOME, cwd: CWD };

const denied = (p: string) => checkPreviewPath(p, opts).deniedReason;
const allowed = (p: string) => checkPreviewPath(p, opts).deniedReason === null;

describe('checkPreviewPath — 拒绝凭据材料', () => {
    it('拒绝 ~/.secrets 整棵树（这是本闸最主要的目标）', () => {
        expect(denied('~/.secrets/env/provider.env')).toBeTruthy();
        expect(denied('/home/tester/.secrets')).toBeTruthy();
        expect(denied('/home/tester/.secrets/deep/nested/file.txt')).toBeTruthy();
    });

    it('拒绝其他凭据目录', () => {
        for (const p of [
            '~/.ssh/id_ed25519',
            '~/.ssh/config',
            '~/.gnupg/secring.gpg',
            '~/.aws/credentials',
            '~/.kube/config',
            '~/.config/rbw/config.json',
        ]) {
            expect(denied(p), p).toBeTruthy();
        }
    });

    it('拒绝精确命中的单个文件', () => {
        expect(denied('~/.claude.json')).toBeTruthy();
        expect(denied('~/.claude/.credentials.json')).toBeTruthy();
        expect(denied('~/.netrc')).toBeTruthy();
    });

    it('按 basename 拒绝 .env 系列与密钥材料，与目录无关', () => {
        for (const p of [
            '/tmp/.env',
            '/tmp/.env.local',
            '/tmp/prod.env',
            '~/code/project/server.pem',
            '~/code/project/tls.key',
            '/tmp/store.p12',
            '/tmp/id_rsa',
            '/var/www/.htpasswd',
        ]) {
            expect(denied(p), p).toBeTruthy();
        }
    });

    it('拒绝 .git/config（可能带 token 的 remote url）', () => {
        expect(denied('~/code/project/.git/config')).toBeTruthy();
    });
});

describe('checkPreviewPath — 绕法必须无效', () => {
    it('`..` 穿越在 resolve 之后照样被挡', () => {
        expect(denied('/home/tester/code/../.ssh/id_rsa')).toBeTruthy();
        expect(denied('../../.secrets/env/x.env')).toBeTruthy();
    });

    it('相对路径按 cwd 解析后再判', () => {
        // CWD = ~/code/project，所以这条落在 ~/code/project/.git/config
        expect(denied('.git/config')).toBeTruthy();
    });

    it('前缀相似的目录不被误判（分隔符必须参与比较）', () => {
        // /home/tester/.secretsauce 不在 /home/tester/.secrets 下
        expect(allowed('/home/tester/.secretsauce/notes.md')).toBe(true);
    });
});

describe('checkPreviewPath — 正常文件必须放行', () => {
    it('放行普通产物', () => {
        for (const p of [
            '~/code/project/README.md',
            '/tmp/report.pdf',
            '~/Downloads/chart.png',
            '~/code/project/src/index.ts',
            'docs/backlog.md',
            '~/code/project/.gitignore',
            '~/code/project/environment.md',
        ]) {
            expect(allowed(p), p).toBe(true);
        }
    });

    it('展开 ~ 并 resolve 成绝对路径', () => {
        expect(checkPreviewPath('~/a/b.md', opts).resolved).toBe('/home/tester/a/b.md');
        expect(checkPreviewPath('~', opts).resolved).toBe(HOME);
        expect(checkPreviewPath('b.md', opts).resolved).toBe('/home/tester/code/project/b.md');
    });
});

describe('checkPreviewPath — 垃圾输入不崩', () => {
    it('拒绝非字符串/空串/NUL', () => {
        expect(denied('')).toBeTruthy();
        expect(denied('   ')).toBeTruthy();
        expect(checkPreviewPath(null, opts).deniedReason).toBeTruthy();
        expect(checkPreviewPath(42 as unknown as string, opts).deniedReason).toBeTruthy();
        expect(checkPreviewPath({} as unknown as string, opts).deniedReason).toBeTruthy();
        expect(denied('/tmp/a\0b.md')).toBeTruthy();
    });
});
