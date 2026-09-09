import { describe, expect, it } from 'vitest';
import { pendingIntentKey, readPendingIntent, retainPendingIntent, clearPendingIntent, canReplaceRejectedIntent } from './pendingIntent';
function fixture() {
  const records = new Map<string,string>();
  return { getItem:(key:string)=>records.get(key)??null, setItem:(key:string,value:string)=>{records.set(key,value);}, removeItem:(key:string)=>{records.delete(key);} };
}
const parse=(value:unknown)=>value as {requestId:string;machineId:string;goal:string};
const first={requestId:'one',machineId:'mac1',goal:'Original goal'};
describe('durable team form intent',()=>{
  it('recovers the same request and full payload after remount instead of replacing unknown work',()=>{
    const storage=fixture();const key=pendingIntentKey('https://relay','account','create');
    expect(retainPendingIntent(key,first,parse,storage)).toEqual(first);
    expect(readPendingIntent(key,parse,storage)).toEqual(first);
    expect(retainPendingIntent(key,{requestId:'two',machineId:'mac2',goal:'Replacement'},parse,storage)).toEqual(first);
  });
  it('isolates server, account, and adopted session or target team',()=>{
    expect(new Set([pendingIntentKey('https://a','owner','adopt:s1'),pendingIntentKey('https://b','owner','adopt:s1'),pendingIntentKey('https://a','other','adopt:s1'),pendingIntentKey('https://a','owner','adopt:s2')]).size).toBe(4);
    expect(()=>pendingIntentKey('https://a','','create')).toThrow();
  });
  it('does not let a late completion erase another request',()=>{
    const storage=fixture();retainPendingIntent('key',first,parse,storage);
    clearPendingIntent('key','other',storage);expect(readPendingIntent('key',parse,storage)).toEqual(first);
    clearPendingIntent('key','one',storage);expect(readPendingIntent('key',parse,storage)).toBeNull();
  });
  it('fails before dispatch if the durable write or retained data is invalid',()=>{
    const storage=fixture();storage.setItem=()=>{throw Error('quota');};
    expect(()=>retainPendingIntent('key',first,parse,storage)).toThrow('quota');
    expect(()=>readPendingIntent('key',parse,{getItem:()=>'{broken'})).toThrow();
  });
});

it('retains an uncertain launch when later authentication or validation fails',()=>{
  for (const status of [400,401,403,404,408,409,429,503]) expect(canReplaceRejectedIntent(true,status)).toBe(false);
  expect(canReplaceRejectedIntent(false,400)).toBe(true);
  expect(canReplaceRejectedIntent(false,408)).toBe(false);
  expect(canReplaceRejectedIntent(false,409)).toBe(false);
  expect(canReplaceRejectedIntent(false,503)).toBe(false);
});
