import { readConfig } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createApp } from './app.js';
import { seedDemo, demoAdapters } from './demo.js';
import { processLock, startLoop } from './runtime.js';

const config = readConfig();
const store = new Store(config.dataDir, config.demo ? 'demo' : 'live');
const release = processLock(config.dataDir, 'web');
if (config.demo) seedDemo(store);
const engine = new Engine(store, config, config.demo ? demoAdapters(store, config) : {});
const stopWorker = config.embedWorker ? startLoop(engine) : async () => {};
const server = createApp(store, config, engine).listen(config.port, config.host, () =>
  console.log(
    `FeedRelay API: http://${config.host}:${config.port}${config.demo ? ' (demo, no external services)' : ''}`,
  ),
);
server.on('error', async () => {
  console.error('PORT_IN_USE_OR_UNAVAILABLE');
  await stopWorker();
  release();
  store.close();
  process.exitCode = 1;
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await stopWorker();
  server.closeAllConnections();
  server.close(() => {
    release();
    store.close();
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
