// Runtime observations, not gate evidence. One fresh local context per node.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { assertControlPath, ControlError, nonce, now } from '../control/common.mjs';
import { readSchedulerRecord, saveSchedulerRecord, schedulerRecordExists } from '../control/scheduler-store.mjs';

async function location(root, create = false) {
  const { scheduler } = await assertControlPath(root);
  const dir = path.join(scheduler, 'team', 'sessions');
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const part of [scheduler, path.dirname(dir), dir]) {
    const info = await fs.lstat(part).catch(() => null);
    if (info && (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(part) !== part)) throw new ControlError('UNSAFE_API_OBSERVATION', 'Unsafe API observation directory.');
  }
  return path.join(dir, 'current.json');
}
export async function beginApiObservation(root, team, member, brief) {
  const file = await location(root, true);
  const record = { schema_version: 1, kind: 'api-node-observation', session_id: `api-node-${nonce(12)}`, team_digest: team.team_digest,
    member_id: member.id, provider: member.provider, requested_model: member.requested_model, reported_model: null,
    work_item_id: brief.work_item_id, run_id: brief.run_id ?? null, phase: brief.phase, status: 'RUNNING',
    started_at: now(), updated_at: now(), finished_at: null, deadline_at: new Date(Date.now() + member.budget.max_seconds * 1000).toISOString(),
    usage: { turns: 0, tokens: 0, tool_calls: 0 } };
  const persist = async () => { record.updated_at = now(); await saveSchedulerRecord(root, file, record); };
  await persist();
  return {
    async response(model, usage) { record.reported_model = model; record.usage = { ...usage }; await persist(); },
    async finish(status, usage) { record.status = status; record.finished_at = now(); if (usage) record.usage = { ...usage }; await persist(); },
  };
}
export async function readApiObservation(root) {
  const file = await location(root);
  if (!await schedulerRecordExists(root, file)) return null;
  const record = await readSchedulerRecord(root, file);
  if (record.kind !== 'api-node-observation') throw new ControlError('UNSAFE_API_OBSERVATION', 'Unexpected API observation kind.');
  return record;
}
