import { buildApp } from './server.js';
import { enableEnrichment } from './enrichment.js';

const ctx = buildApp();
enableEnrichment(ctx);

ctx.app
  .listen({ port: ctx.config.port, host: '0.0.0.0' })
  .then(() => console.log(`scrible backend listening on :${ctx.config.port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
