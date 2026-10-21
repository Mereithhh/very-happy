import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTranscript, classifyTurn, summarize, userOwnText } from './project-metrics.mjs';

const user = (text) => JSON.stringify({ type: 'user', message: { content: text } });
const toolResult = () => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } });
const assistant = (id, tokens, tools = []) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: tokens, output_tokens: 0 }, content: tools.map((name) => ({ type: 'tool_use', name })) } });

test('classifies turns by the injected headers', () => {
  assert.equal(classifyTurn('[Very Happy session message ab from "x"] hi'), 'peer');
  assert.equal(classifyTurn('[Very Happy project "p" · instructions v1]\n…'), 'project');
  assert.equal(classifyTurn('[Project "p" since your last turn: …]\nq'), 'digest');
  assert.equal(classifyTurn('hello'), 'other');
});

test('tokens per turn de-duplicate assistant lines by message id; tool results are not turns', async () => {
  const s = await analyzeTranscript([
    user('[Very Happy project "p" · instructions v1]\nWhat is 2+2?'),
    assistant('m1', 100), assistant('m1', 100), toolResult(), assistant('m2', 50, ['mcp__happy__project_context']),
    user('[Very Happy session message ab from "x"] please rebase'),
    assistant('m3', 30, ['mcp__happy__session_message']),
  ]);
  assert.equal(s.turns.length, 2);
  assert.deepEqual(s.turns.map((t) => [t.kind, t.tokens, t.projectToolCalls]), [['project', 150, 1], ['peer', 30, 1]]);
  assert.equal(s.isProject, true);
  const r = summarize([s, await analyzeTranscript([user('plain'), assistant('z', 10)])]);
  assert.equal(r.projectSessions, 1);
  assert.equal(r.peerTokenShare, 0.1667);
  assert.equal(r.projectContextPerSessionMedian, 1);
  assert.equal(r.s2SessionsThatSentPeerMessages, 1);
});

test('S1 judges the user\'s own words, not the injected prefix', async () => {
  assert.equal(userOwnText('[Very Happy project "p"]\nrules\n---\nvariant\n---\nWhat is 2+2?', 'project'), 'What is 2+2?');
  assert.equal(userOwnText('[Project "p" since your last turn: x]\nWhy?', 'digest'), 'Why?');
  const s = await analyzeTranscript([user('[Very Happy project "p"]\nrules\n---\nvariant\n---\nWhat is 2+2?'), assistant('a', 5)]);
  assert.equal(s.turns[0].oneLine, true);
});
