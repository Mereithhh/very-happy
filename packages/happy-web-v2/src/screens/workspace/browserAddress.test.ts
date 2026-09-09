import { expect, it } from 'vitest';
import { browserAddress } from './browserAddress';
it('normalizes web addresses and rejects executable URLs, credentials and recursive app embeds',()=>{
 const origin='https://veryhappy.dev';
 expect(browserAddress('example.com/path',origin)).toBe('https://example.com/path');
 expect(browserAddress('http://localhost:3000',origin)).toBe('http://localhost:3000/');
 expect(browserAddress('localhost:3000',origin)).toBe('https://localhost:3000/');
 for(const value of ['', 'javascript:alert(1)','data:text/html,hello','file:///etc/passwd','https://user:secret@example.com','https://veryhappy.dev/session/a'])expect(browserAddress(value,origin)).toBeNull();
});
