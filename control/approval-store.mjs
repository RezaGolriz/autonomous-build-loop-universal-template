import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlError, jsonDigest } from './common.mjs';

async function hostKey(root, create) {
  root = await fs.realpath(root);
  const location = path.resolve(process.env.BUILD_LOOP_APPROVAL_STORE || path.join(os.homedir(), '.local', 'state', 'universal-build-loop'));
  if (location === root || location.startsWith(`${root}${path.sep}`)) throw new ControlError('UNSAFE_APPROVAL_STORE', 'approval trust must be stored outside the controlled project');
  if (create) await fs.mkdir(location, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(location).catch(() => null);
  if (!directory || !directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new ControlError('UNSAFE_APPROVAL_STORE', 'approval store must be a private directory owned by the current user');
  const canonical = await fs.realpath(location);
  if (canonical === root || canonical.startsWith(`${root}${path.sep}`)) throw new ControlError('UNSAFE_APPROVAL_STORE', 'approval trust resolves inside the controlled project');
  const file = path.join(location, 'approval-key');
  if (create) { try { await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new ControlError('APPROVAL_UNTRUSTED', 'no trusted local approval key is available; request human approval again');
  const key = await fs.readFile(file);
  if (key.length !== 32) throw new ControlError('APPROVAL_UNTRUSTED', 'local approval key is invalid');
  return key;
}
function payload(root, receipt) {
  return JSON.stringify([1, root, receipt.setup_digest, receipt.approval_id, receipt.channel, receipt.approved_at, receipt.decision]);
}
export async function signApproval(root, receipt) {
  root = await fs.realpath(root);
  return createHmac('sha256', await hostKey(root, true)).update(payload(root, receipt)).digest('hex');
}
export async function verifyApproval(root, receipt) {
  root = await fs.realpath(root);
  if (!receipt || receipt.decision !== 'APPROVE' || !['local-http-user', 'interactive-tty'].includes(receipt.channel) || !/^[a-f0-9]{64}$/.test(receipt.host_signature || '')) throw new ControlError('APPROVAL_UNTRUSTED', 'approval is not signed by this local host; request human approval');
  const expected = createHmac('sha256', await hostKey(root, false)).update(payload(root, receipt)).digest();
  if (!timingSafeEqual(expected, Buffer.from(receipt.host_signature, 'hex'))) throw new ControlError('APPROVAL_UNTRUSTED', 'approval signature does not match this project and host');
  return receipt;
}

function hostConfigPayload(root, config) {
  const { host_signature, ...unsigned } = config;
  return JSON.stringify(['host-configuration-v1', root, jsonDigest(unsigned)]);
}
export async function signHostConfiguration(root, config) {
  root = await fs.realpath(root);
  return createHmac('sha256', await hostKey(root, true)).update(hostConfigPayload(root, config)).digest('hex');
}
export async function verifyHostConfiguration(root, config) {
  root = await fs.realpath(root);
  if (!config || !/^[a-f0-9]{64}$/.test(config.host_signature || '')) throw new ControlError('HOST_UNTRUSTED', 'configure the host locally before running authentication checks');
  const expected = createHmac('sha256', await hostKey(root, false)).update(hostConfigPayload(root, config)).digest();
  if (!timingSafeEqual(expected, Buffer.from(config.host_signature, 'hex'))) throw new ControlError('HOST_UNTRUSTED', 'host configuration changed; configure it again locally');
  return config;
}

// Human confirmation of one exact decision (accept, authorize, promote). The
// receipt binds the local host key to the request id and to the digest of the
// frozen request the person actually saw, so a confirmation can never be
// replayed against another decision or against a changed one.
function operationPayload(root, receipt) {
  return JSON.stringify(['operation-confirmation-v2', root, receipt.operation, receipt.item_id ?? null, receipt.request_digest, receipt.request_id, receipt.channel, receipt.assurance, receipt.confirmed_at, receipt.decision]);
}
export async function signOperationConfirmation(root, receipt) {
  root = await fs.realpath(root);
  return createHmac('sha256', await hostKey(root, true)).update(operationPayload(root, receipt)).digest('hex');
}
export async function verifyOperationConfirmation(root, receipt) {
  root = await fs.realpath(root);
  if (!receipt || receipt.decision !== 'APPROVE' || receipt.channel !== 'local-http-user' || receipt.assurance !== 'local-user-action'
      || !/^[a-f0-9]{64}$/.test(receipt.request_digest || '') || !/^[a-f0-9]{64}$/.test(receipt.host_signature || '')) throw new ControlError('CONFIRMATION_UNTRUSTED', 'this confirmation is not signed by the local host; ask the person to confirm again');
  const expected = createHmac('sha256', await hostKey(root, false)).update(operationPayload(root, receipt)).digest();
  if (!timingSafeEqual(expected, Buffer.from(receipt.host_signature, 'hex'))) throw new ControlError('CONFIRMATION_UNTRUSTED', 'confirmation signature does not match this project and host');
  return receipt;
}
