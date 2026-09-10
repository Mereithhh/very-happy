import {describe,it,expect} from 'vitest';
import {codingAgentFromProcessTree} from './agentProcess';
describe('runtime process identity',()=>{
 it('recognizes the actual node launchers and Pi process title',()=>{
  expect(codingAgentFromProcessTree(10,'10 1 node /opt/bin/codex --no-alt-screen')).toBe('codex');
  expect(codingAgentFromProcessTree(10,'10 1 pi')).toBe('pi');
  expect(codingAgentFromProcessTree(10,'10 1 zsh\n11 10 node /opt/bin/codex\n12 11 /opt/native/codex')).toBe('codex');
 });
 it('ignores prompts, unrelated processes and missing pids',()=>{
  expect(codingAgentFromProcessTree(10,'10 1 node server.js pi codex\n20 1 pi')).toBeUndefined();
  expect(codingAgentFromProcessTree(30,'20 1 pi')).toBeUndefined();
 });
 it('does not loop on malformed process cycles',()=>{
  expect(codingAgentFromProcessTree(10,'10 11 node server.js\n11 10 node server.js')).toBeUndefined();
 });
});
