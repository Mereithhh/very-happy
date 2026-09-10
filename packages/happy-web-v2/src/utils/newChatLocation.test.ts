import { expect, it } from 'vitest';
import { newChatLocation } from './newChatLocation';

const sessions = { first: { metadata: { machineId: 'a', path: '/one' } }, second: { metadata: { machineId: 'b', path: '/two' } } };
it('uses the viewed session, including nested routes, instead of another running/recent session', () => {
    expect(newChatLocation({ pathname: '/session/second' }, sessions, [])).toEqual({ machineId: 'b', path: '/two' });
    expect(newChatLocation({ pathname: '/session/second/files' }, sessions, [])).toEqual({ machineId: 'b', path: '/two' });
    expect(newChatLocation({ pathname: '/settings' }, sessions, [])).toBeUndefined();
    expect(newChatLocation({ pathname: '/session/%XX' }, sessions, [])).toBeUndefined();
});
it('uses only a terminal belonging to the route machine and preserves its exact cwd', () => {
    const terminals = [{ id: 'term', machineId: 'b', cwd: 'C:\\My Project\\' }];
    expect(newChatLocation({ pathname: '/terminal/b', search: '?tid=term' }, sessions, terminals)).toEqual({ machineId: 'b', path: 'C:\\My Project\\' });
    expect(newChatLocation({ pathname: '/terminal/a', search: '?tid=term' }, sessions, terminals)).toBeUndefined();
});
it('keeps a known machine with unknown directory so the caller asks instead of using unrelated history', () => {
    expect(newChatLocation({ pathname: '/session/new' }, { new: { metadata: { machineId: 'b' } } }, [])).toEqual({ machineId: 'b', path: '' });
});
