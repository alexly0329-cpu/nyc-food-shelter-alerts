import { readFileSync } from 'node:fs';
import { Vonage } from '@vonage/server-sdk';
import type { Sender } from '../alerts/send.js';

// Env is read at call time so the app boots (and tests run) without Vonage configured.
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function client(): Vonage {
  const applicationId = need('VONAGE_APPLICATION_ID');
  const key = need('VONAGE_PRIVATE_KEY');
  // Inline PEM, or a path to a PEM file.
  const privateKey = key.includes('-----BEGIN') ? key.replace(/\\n/g, '\n') : readFileSync(key, 'utf8');
  return new Vonage({ applicationId, privateKey });
}

const digits = (e164: string) => e164.replace(/^\+/, '');

export function createVonageSender(): Sender {
  return {
    async sendSms(to, text) {
      const from = need('VONAGE_NUMBER');
      const r = await client().messages.send({ channel: 'sms', messageType: 'text', to: digits(to), from: digits(from), text });
      return { id: r.messageUUID };
    },
    async startCall(to, text, language) {
      const from = need('VONAGE_NUMBER');
      const r = await client().voice.createOutboundCall({
        to: [{ type: 'phone', number: digits(to) }],
        from: { type: 'phone', number: digits(from) },
        ncco: [{ action: 'talk', text, language }],
      });
      return { id: r.uuid };
    },
  };
}
