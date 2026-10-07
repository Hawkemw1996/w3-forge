// Same AES-256-GCM scheme as BuildCost, with a Forge-specific key domain.
// Browser tokens remain hashed; Core app tokens are sealed in server memory.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface SessionSecrets { sessionSecret?: string; pairingSecret?: string; serviceToken?: string }
export function sessionSecretIssue(secrets: SessionSecrets): { code: string; message: string } | null {
  const secret = secrets.sessionSecret ?? '';
  if (secret.length < 32 || secret.length > 4096 || secret.trim() !== secret) {
    return { code: 'SESSION_SECRET_MISSING', message: 'Configure a separate FORGE_SESSION_SECRET with at least 32 characters before signing in.' };
  }
  const values = [secret, secrets.pairingSecret, secrets.serviceToken].filter((s): s is string => !!s);
  if (new Set(values).size !== values.length) {
    return { code: 'AUTH_SECRET_REUSE', message: 'Forge session, installation pairing and Core resource-service secrets must be distinct.' };
  }
  return null;
}
function key(secret: string): Buffer {
  if (sessionSecretIssue({ sessionSecret: secret })) throw new Error('Forge session encryption is not configured.');
  return createHash('sha256').update('w3forge-session-v1:' + secret, 'utf8').digest();
}
export function encryptCoreSession(token: string, secret: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || token.length !== 43) throw new Error('Invalid Core app session.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([cipher.update('app-v1:' + token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function decryptCoreSession(sealed: string, secret: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(p => !/^[A-Za-z0-9_-]+$/.test(p) || p.trim() !== p)) {
    throw new Error('Invalid sealed Core app session.');
  }
  const [, iv, tag, body] = parts.map((p,i) => i ? Buffer.from(p,'base64url') : Buffer.alloc(0));
  if (iv.length !== 12 || tag.length !== 16 || body.length !== 50) throw new Error('Invalid sealed Core app session.');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  if (!plain.startsWith('app-v1:') || !/^[A-Za-z0-9_-]{43}$/.test(plain.slice(7))) throw new Error('Invalid Core app session.');
  return plain.slice(7);
}
