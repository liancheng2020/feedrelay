import { readConfig } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { startLoop } from './runtime.js';

const config = readConfig();
if (config.demo) throw new Error('Demo uses an embedded worker. Run npm run demo.');
const store = new Store(config.dataDir);
const stop = startLoop(new Engine(store, config));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await stop();
  store.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
