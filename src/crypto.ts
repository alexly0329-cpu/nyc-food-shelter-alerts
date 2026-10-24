import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from './config.js';

const IV_LEN = 12;
const TAG_LEN = 16;
const key = Buffer.from(config.PHONE_ENCRYPTION_KEY, 'base64');

// Layout: iv (12) | auth tag (16) | ciphertext
export function encryptPhone(e164: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(e164, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptPhone(b: Buffer): string {
  if (b.length <= IV_LEN + TAG_LEN) throw new Error('Invalid encrypted phone');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, IV_LEN), { authTagLength: TAG_LEN });
  d.setAuthTag(b.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([d.update(b.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
}

export function phoneHash(e164: string): string {
  return createHmac('sha256', Buffer.from(config.PHONE_HASH_KEY, 'base64')).update(e164).digest('hex');
}
