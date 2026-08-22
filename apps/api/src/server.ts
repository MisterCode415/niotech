import { buildApp } from './app.js';
import { devAuthIsOpen, env, smtpIsLocalCapture } from './env.js';

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
  if (smtpIsLocalCapture) {
    app.log.warn(`Email is being captured at ${env.SMTP_HOST}, not delivered to recipients.`);
  } else if (!env.SMTP_USER) {
    // Delivery failures are caught and logged per message, so without this the first sign of a
    // misconfigured relay would be a patient saying they never got their results.
    app.log.warn(
      `SMTP relay ${env.SMTP_HOST} is configured without credentials. If it does not authorise ` +
        'this server by IP, every notification email will silently fail to deliver.',
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
