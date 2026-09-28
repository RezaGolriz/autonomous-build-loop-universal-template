import { supervisorWorker } from './supervisor.mjs';
const [root, id, fence] = process.argv.slice(2);
if (!root || !id || !fence) process.exit(64);
await supervisorWorker(root, id, fence);
