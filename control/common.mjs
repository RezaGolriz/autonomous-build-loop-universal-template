import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class ControlError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export const nonce = (bytes = 18) => randomBytes(bytes).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const jsonDigest = (value) => sha256(JSON.stringify(sortObject(value)));

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

export async function exists(file) {
  try { await fs.access(file, constants.F_OK); return true; } catch { return false; }
}

export async function readJson(file, label = path.basename(file)) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    assertPlain(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError('INVALID_JSON', `${label} is not valid JSON`, { file, cause: typeof error.code === 'string' ? error.code : 'Invalid JSON syntax' });
  }
}

async function safeParent(file) {
  let current = path.dirname(path.resolve(file));
  for (;;) {
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new ControlError('UNSAFE_CONTROL_PATH', 'refusing a write through a symlinked directory');
      return;
    }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}

export async function atomicJson(file, value, mode = 0o600) {
  await safeParent(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${nonce(6)}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
  await fs.rename(temp, file);
}

export async function atomicText(file, value, mode = 0o600) {
  await safeParent(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${nonce(6)}.tmp`);
  await fs.writeFile(temp, value, { mode, flag: 'wx' });
  await fs.rename(temp, file);
}

export function assertPlain(value, label = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlError('INVALID_INPUT', `${label} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new ControlError('INVALID_INPUT', `${label} must be a plain object`);
  }
  const walk = (item, where) => {
    if (!item || typeof item !== 'object') return;
    for (const key of Object.keys(item)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new ControlError('INVALID_INPUT', `${where} contains forbidden key ${key}`);
      }
      walk(item[key], `${where}.${key}`);
    }
  };
  walk(value, label);
}

export function exactKeys(value, allowed, required = [], label = 'input') {
  assertPlain(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ControlError('UNKNOWN_FIELD', `${label} has unknown field(s): ${unknown.join(', ')}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new ControlError('MISSING_INPUT', `${label} is missing: ${missing.join(', ')}`, { missing_inputs: missing });
}

export function stringValue(value, label, { min = 1, max = 10000, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw new ControlError('INVALID_INPUT', `${label} is invalid`);
  }
  return value;
}

export function intValue(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new ControlError('INVALID_INPUT', `${label} must be an integer from ${min} to ${max}`);
  return value;
}

export function stringArray(value, label, { min = 0, max = 128, pattern } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new ControlError('INVALID_INPUT', `${label} must contain ${min}-${max} strings`);
  const result = value.map((item, index) => stringValue(item, `${label}[${index}]`, { max: 4096, pattern }));
  if (new Set(result).size !== result.length) throw new ControlError('INVALID_INPUT', `${label} contains duplicates`);
  return result;
}

export function safeRelative(value, label = 'path') {
  stringValue(value, label, { max: 1024 });
  if (path.isAbsolute(value) || /[\0-\x1f\x7f|`,;]/.test(value) || value.split(/[\\/]/).some((part) => part === '..') || value === '') {
    throw new ControlError('UNSAFE_PATH', `${label} must be a repository-relative path without ..`);
  }
  return value.replaceAll('\\', '/');
}

export function safeRelativeArray(value, label, min = 0) {
  return stringArray(value, label, { min }).map((item, index) => safeRelative(item, `${label}[${index}]`));
}

export async function resolveRoot(root) {
  stringValue(root, 'root', { max: 4096 });
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new ControlError('INVALID_ROOT', 'root must be an existing non-symlink directory');
  const resolved = await fs.realpath(root);
  if (resolved === path.parse(resolved).root || resolved === await fs.realpath(os.homedir())) throw new ControlError('DANGEROUS_ROOT', 'refusing a filesystem root or the user home directory as a build-loop project');
  return resolved;
}

export async function assertControlPath(root) {
  const loop = path.join(root, '.loop');
  const stat = await fs.lstat(loop).catch(() => null);
  if (stat?.isSymbolicLink()) throw new ControlError('UNSAFE_CONTROL_PATH', 'refusing symlinked .loop directory');
  if (stat && !stat.isDirectory()) throw new ControlError('UNSAFE_CONTROL_PATH', '.loop exists but is not a directory');
  if (stat && await fs.realpath(loop) !== loop) throw new ControlError('UNSAFE_CONTROL_PATH', '.loop resolves outside the project');
  const control = path.join(loop, 'control');
  const cstat = await fs.lstat(control).catch(() => null);
  if (cstat?.isSymbolicLink() || (cstat && !cstat.isDirectory())) throw new ControlError('UNSAFE_CONTROL_PATH', 'refusing unsafe .loop/control');
  return { loop, control };
}

export async function ensureRuntimeIgnore(root) {
  const { loop } = await assertControlPath(root);
  await fs.mkdir(loop, { recursive: true });
  const rules = '# Machine-local build-loop data. Review work items before sharing.\n/host.local.json\n/control/\n/candidate/\n/evidence/\n/*lock*\n/quarantine.json\n/*.snapshot.json\n/dashboard.html\n';
  try { await fs.writeFile(path.join(loop, '.gitignore'), rules, { flag: 'wx', mode: 0o644 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export async function assertNoEngineLock(root) {
  for (const name of ['engine.lock', 'orchestrator.lock']) {
    if (await exists(path.join(root, '.loop', name))) throw new ControlError('WORKSPACE_LOCKED', `workspace lock is active: .loop/${name}`);
  }
}

export async function acquireDirLock(directory, metadata = {}) {
  try { await fs.mkdir(directory, { recursive: false }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new ControlError('WORKSPACE_LOCKED', `lock is active: ${directory}`);
    throw error;
  }
  await atomicJson(path.join(directory, 'owner.json'), { pid: process.pid, created_at: now(), ...metadata });
  return async () => {
    await fs.rm(path.join(directory, 'owner.json'), { force: true });
    await fs.rmdir(directory).catch(() => {});
  };
}

export function publicError(error) {
  if (error instanceof ControlError) return { ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: error?.message || String(error) } };
}

export function effectivePath() {
  const home = os.homedir();
  return [...new Set([...(process.env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.npm-global', 'bin'), '/Applications/Codex.app/Contents/Resources', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(value => path.isAbsolute(value)))].join(path.delimiter);
}
