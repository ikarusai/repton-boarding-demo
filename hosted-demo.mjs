// Dedicated fictional Render entry point. Never imports school environment settings.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoServer } from './demo-server.mjs';

const port = Number(process.env.PORT || 10000);
const publicOrigin = process.env.RENDER_EXTERNAL_URL || '';
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(publicOrigin)) {
  throw new Error('RENDER_EXTERNAL_URL must be the exact HTTPS Render service address.');
}
const directory = await mkdtemp(join(tmpdir(), 'repton-boarding-demo-'));
let instance;
try {
  instance = await startDemoServer({port, publicOrigin, hosted:true, stateFile:join(directory,'fictional-state.json')});
} catch (error) {
  await rm(directory,{recursive:true,force:true});
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await instance.close();
  await rm(directory,{recursive:true,force:true});
  process.exit(0);
}
process.once('SIGTERM',stop);
process.once('SIGINT',stop);
