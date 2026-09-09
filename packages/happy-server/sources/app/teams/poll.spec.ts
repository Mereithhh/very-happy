import { it, expect } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { teamPollOperations } from './poll';
it('requires an archive-aware daemon and omits cancelled launches from polling', () => {
    const active = {operations:[{id:'active',status:'pending'}]} as TeamState;
    const archived = {archivedAt:1,operations:[{id:'stop',status:'pending'},{id:'cancelled',status:'failed',error:'task_closed_before_spawn'}]} as TeamState;
    expect(teamPollOperations([active,archived],{}).map(o=>o.id)).toEqual(['active']);
    expect(teamPollOperations([active,archived],{teamArchiveVersion:1}).map(o=>o.id)).toEqual(['active','stop']);
});
