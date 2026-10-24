import { createVonageSender } from './integrations/vonage.js';
import { geocodeAddress } from './integrations/geocode.js';
import { createTavilyClient } from './integrations/tavily.js';
import { getPool, migrate } from './db.js';
import { createQueue } from './queue.js';
import { buildServer } from './server.js';

const pool = getPool();
await migrate(pool);
const sender = createVonageSender();
const queue = createQueue({ pool, sender });
await queue.start();

const app = buildServer({
  db: pool,
  tavily: createTavilyClient(),
  geocode: geocodeAddress,
  sender,
  enqueue: queue.enqueue,
  now: () => new Date(),
  signatureSecret: () => process.env.VONAGE_SIGNATURE_SECRET,
  secureCookies: process.env.NODE_ENV === 'production',
});

const stop = async () => {
  await app.close();
  await queue.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
