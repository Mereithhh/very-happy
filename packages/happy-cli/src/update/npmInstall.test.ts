import { describe, it, expect, vi } from 'vitest';
import { installCliSafely, ownedCliLink, type InstallDependencies } from './npmInstall';
function fixture() {
 const directory = {isDirectory:()=>true,isSymbolicLink:()=>false};
 const fs = { lstat: vi.fn(async (path: string) => { if(path.endsWith('very-happy-cli')) return directory; throw Object.assign(new Error(),{code:'ENOENT'}); }), readFile: vi.fn(async()=>'{"name":"very-happy-cli"}'), readlink: vi.fn(), unlink: vi.fn(), rm: vi.fn(), symlink: vi.fn() };
 const npm = vi.fn(async (args: string[]) => ({code:args[0]==='i'?1:0,stderr: 'npm error ENOTEMPTY',stdout:args[0]==='root'?'/opt/npm/lib/node_modules':args[0]==='prefix'?'/opt/npm':''}));
 return {fs,npm,deps:{fs,npm,platform:'linux'} as unknown as InstallDependencies};
}
describe('bounded npm recovery',()=>{
 it('runs at most two installs and only removes the verified CLI package',async()=>{
  const {deps,npm,fs}=fixture(); await expect(installCliSafely('0.2.123',deps)).resolves.toBe(1);
  expect(npm.mock.calls.filter(([args])=>args[0]==='i')).toHaveLength(2);
  expect(fs.rm).toHaveBeenCalledExactlyOnceWith('/opt/npm/lib/node_modules/very-happy-cli',{recursive:true,force:true});
 });
 it('never cleans up after timeout or spawn errors',async()=>{
  const {deps,npm,fs}=fixture(); npm.mockImplementation(async args=>({code:args[0]==='i'?null:0,stderr: 'npm error ENOTEMPTY',stdout:args[0]==='root'?'/opt/npm/lib/node_modules':'/opt/npm'}) as any);
  await installCliSafely('0.2.123',deps); expect(fs.rm).not.toHaveBeenCalled();
 });
 it('refuses foreign package identity without running install',async()=>{
  const {deps,npm,fs}=fixture(); fs.readFile.mockResolvedValue('{"name":"another-package"}');
  await expect(installCliSafely('0.2.123',deps)).rejects.toThrow('identity'); expect(npm.mock.calls).toHaveLength(2); expect(fs.rm).not.toHaveBeenCalled();
 });
 it('does not remove a healthy tree on network failure',async()=>{
  const {deps,npm,fs}=fixture(); npm.mockImplementation(async args=>({code:args[0]==='i'?1:0,stderr:'ENETUNREACH',stdout:args[0]==='root'?'/opt/npm/lib/node_modules':'/opt/npm'}));
  await installCliSafely('0.2.123',deps); expect(fs.rm).not.toHaveBeenCalled();
  expect(npm.mock.calls.filter(([args])=>args[0]==='i')).toHaveLength(1);
 });
 it('validates both bin links before unlinking either',async()=>{
  const {deps,fs}=fixture();
  fs.lstat.mockImplementation(async path=>path.endsWith('very-happy-cli')?{isDirectory:()=>true,isSymbolicLink:()=>false}:path.endsWith('very-happy-mcp')?{isDirectory:()=>false,isSymbolicLink:()=>false}:{isDirectory:()=>false,isSymbolicLink:()=>true});
  fs.readlink.mockResolvedValue('../lib/node_modules/very-happy-cli/bin/very-happy.mjs');
  await expect(installCliSafely('0.2.123',deps)).rejects.toThrow('owned');
  expect(fs.unlink).not.toHaveBeenCalled(); expect(fs.rm).not.toHaveBeenCalled();
 });
 it('refuses a linked package tree',async()=>{
  const {deps,fs}=fixture(); fs.lstat.mockResolvedValue({isDirectory:()=>false,isSymbolicLink:()=>true});
  await expect(installCliSafely('0.2.123',deps)).rejects.toThrow('linked'); expect(fs.rm).not.toHaveBeenCalled();
 });
 it('does not mistake similar names or traversal for owned links',()=>{
  expect(ownedCliLink('/opt/npm/bin/very-happy','../lib/node_modules/very-happy-cli/bin/happy.mjs','/opt/npm/lib/node_modules/very-happy-cli')).toBe(true);
  expect(ownedCliLink('/opt/npm/bin/very-happy','../foreign-very-happy-cli/bin/x','/opt/npm/lib/node_modules/very-happy-cli')).toBe(false);
  expect(ownedCliLink('/opt/npm/bin/very-happy','../lib/node_modules/very-happy-cli/bin/../../other/bin/x','/opt/npm/lib/node_modules/very-happy-cli')).toBe(false);
 });
});
