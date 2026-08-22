import { buildApp } from './app.js';
import { devAuthIsOpen, env } from './env.js';

const app = await buildApp();

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  app.log.info(`Auth provider: ${env.AUTH_PROVIDER}`);
  if (devAuthIsOpen) {
    app.log.warn(
      'Dev auth is active: anyone who can reach this API can sign in as any account without a ' +
        'password. This deployment must stay behind a private gate.',
    );
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
