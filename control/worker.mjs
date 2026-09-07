import { workerRun } from './jobs.mjs';

const [root, jobId] = process.argv.slice(2);
if (!root || !jobId) process.exit(64);
await workerRun(root, jobId);
