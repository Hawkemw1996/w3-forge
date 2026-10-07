import { describe, expect, it } from 'vitest';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { decryptCoreSession, encryptCoreSession, sessionSecretIssue } from '../src/auth/sessionCrypto';

const secret = 'forge-session-unique-secret-0123456789012345';
const token = 'T'.repeat(43);

describe('encrypted Core app sessions', () => {
  it('seals tokens with randomized authenticated encryption and round-trips only with the correct key', () => {
    const first=encryptCoreSession(token,secret), second=encryptCoreSession(token,secret);
    expect(first).not.toBe(second);
    expect(first).not.toContain(token);
    expect(decryptCoreSession(first,secret)).toBe(token);
    expect(()=>decryptCoreSession(first,'rotated-forge-session-secret-0123456789012345')).toThrow();
  });
  it('refuses altered ciphertext, authentication tags, IVs and malformed formats', () => {
    const sealed=encryptCoreSession(token,secret);
    for(const part of [1,2,3]){
      const values=sealed.split('.');const bytes=Buffer.from(values[part],'base64url');bytes[0]^=1;values[part]=bytes.toString('base64url');
      expect(()=>decryptCoreSession(values.join('.'),secret)).toThrow();
    }
    for(const raw of [token,'v0.a.b.c',sealed+'.extra',sealed+'\n','v1...','v1.a.b.c']) expect(()=>decryptCoreSession(raw,secret)).toThrow();
  });
  it('rejects sessions from another app encryption domain or an invalid inner token', () => {
    const seal=(domain:string,plain:string)=>{
      const iv=randomBytes(12),key=createHash('sha256').update(domain+secret).digest();
      const cipher=createCipheriv('aes-256-gcm',key,iv);
      const body=Buffer.concat([cipher.update(plain),cipher.final()]);
      return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
    };
    expect(()=>decryptCoreSession(seal('w3buildcost-session-v1:','app-v1:'+token),secret)).toThrow();
    expect(()=>decryptCoreSession(seal('w3forge-session-v1:','cookie:'+token),secret)).toThrow();
    for(const raw of ['',token+'\n','not-an-app-token']) expect(()=>encryptCoreSession(raw,secret)).toThrow();
  });
  it('requires a separate session secret and rejects all forms of three-way credential reuse', () => {
    for(const value of ['', 'short', 'x'.repeat(31), secret+'\n']) expect(sessionSecretIssue({sessionSecret:value})?.code).toBe('SESSION_SECRET_MISSING');
    for(const values of [
      {sessionSecret:secret,pairingSecret:secret},
      {sessionSecret:secret,serviceToken:secret},
      {sessionSecret:secret,pairingSecret:'P'.repeat(43),serviceToken:'P'.repeat(43)}
    ]) expect(sessionSecretIssue(values)?.code).toBe('AUTH_SECRET_REUSE');
    expect(sessionSecretIssue({sessionSecret:secret,pairingSecret:'P'.repeat(43),serviceToken:'S'.repeat(43)})).toBeNull();
  });
});
