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
 it('B-489: installs into the running package prefix, not npm default, and verifies the running copy',async()=>{
  const running='/home/u/.local/lib/node_modules/very-happy-cli';
  let installedVersion='0.2.144';
  const fs = { lstat: vi.fn(async (path: string) => { if(path===running) return {isDirectory:()=>true,isSymbolicLink:()=>false}; throw Object.assign(new Error(),{code:'ENOENT'}); }),
   readFile: vi.fn(async()=>JSON.stringify({name:'very-happy-cli',version:installedVersion})), readlink: vi.fn(), unlink: vi.fn(), rm: vi.fn(), symlink: vi.fn(), access: vi.fn(async()=>undefined) };
  const npm = vi.fn(async (args: string[]) => {
   const pinned = args.includes('--prefix=/home/u/.local');
   const prefix = pinned ? '/home/u/.local' : '/opt/conda';
   if (args[0]==='i') { if (pinned) installedVersion='0.2.149'; return {code:0,stdout:''}; }
   return {code:0,stdout:args[0]==='root'?`${prefix}/lib/node_modules`:prefix};
  });
  await expect(installCliSafely('0.2.149',{fs,npm,platform:'linux',runningPackageDir:running} as unknown as InstallDependencies)).resolves.toBe(0);
  expect(npm.mock.calls.map(([args])=>args[0]==='i'?args.join(' '):args.join(' '))).toEqual([
   'root -g --prefix=/home/u/.local','prefix -g --prefix=/home/u/.local',
   'i -g --prefix=/home/u/.local --allow-scripts=very-happy-cli,node-pty very-happy-cli@0.2.149',
  ]);
 });
 it('B-489: npm exit 0 that leaves the running copy unchanged is installed_elsewhere, not success',async()=>{
  const running='/home/u/.local/lib/node_modules/very-happy-cli';
  const fs = { lstat: vi.fn(async (path: string) => { if(path===running) return {isDirectory:()=>true,isSymbolicLink:()=>false}; throw Object.assign(new Error(),{code:'ENOENT'}); }),
   readFile: vi.fn(async()=>'{"name":"very-happy-cli","version":"0.2.144"}'), readlink: vi.fn(), unlink: vi.fn(), rm: vi.fn(), symlink: vi.fn(), access: vi.fn(async()=>undefined) };
  const npm = vi.fn(async (args: string[]) => ({code:0,stdout:args[0]==='root'?'/home/u/.local/lib/node_modules':'/home/u/.local'}));
  await expect(installCliSafely('0.2.149',{fs,npm,platform:'linux',runningPackageDir:running} as unknown as InstallDependencies)).resolves.toEqual({failed:'installed_elsewhere'});
  const win = { ...fs, lstat: vi.fn() };
  await expect(installCliSafely('0.2.149',{fs:win,npm,platform:'win32',runningPackageDir:'C:/npm/node_modules/very-happy-cli'} as unknown as InstallDependencies)).resolves.toEqual({failed:'installed_elsewhere'});
 });
 it('B-489: refuses to guess an install location and never runs npm for it',async()=>{
  const {fs,npm}=fixture();
  fs.readFile.mockResolvedValue('{"name":"very-happy-cli","version":"0.2.144"}');
  await expect(installCliSafely('0.2.149',{fs,npm,platform:'linux',runningPackageDir:'/repo/packages/happy-cli'} as unknown as InstallDependencies)).resolves.toEqual({manual:'install_location_unverified'});
  const access = vi.fn(async (path: string) => { if (path.endsWith('node_modules')) throw Object.assign(new Error(),{code:'EACCES'}); });
  await expect(installCliSafely('0.2.149',{fs:{...fs,access},npm,platform:'linux',runningPackageDir:'/usr/lib/node_modules/very-happy-cli'} as unknown as InstallDependencies)).resolves.toEqual({manual:'install_location_not_writable'});
  expect(npm).not.toHaveBeenCalled(); expect(fs.unlink).not.toHaveBeenCalled();
 });
 it('does not mistake similar names or traversal for owned links',()=>{
  expect(ownedCliLink('/opt/npm/bin/very-happy','../lib/node_modules/very-happy-cli/bin/happy.mjs','/opt/npm/lib/node_modules/very-happy-cli')).toBe(true);
  expect(ownedCliLink('/opt/npm/bin/very-happy','../foreign-very-happy-cli/bin/x','/opt/npm/lib/node_modules/very-happy-cli')).toBe(false);
  expect(ownedCliLink('/opt/npm/bin/very-happy','../lib/node_modules/very-happy-cli/bin/../../other/bin/x','/opt/npm/lib/node_modules/very-happy-cli')).toBe(false);
 });
});
