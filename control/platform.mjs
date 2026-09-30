// Where the loop may run. macOS and Linux are supported. Windows is supported
// only through WSL2 (a real Linux inside Windows); native Windows fails fast.
// Under WSL, a project on a Windows drive (/mnt/c/...) is refused: that
// file system (DrvFs) does not keep the permission, hard-link and exclusive
// create rules the referee depends on for its locks and records.
//
// This file is the single helper for the CLI, the MCP server and
// bootstrap/check-prerequisites.sh (which runs it as a script).
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ControlError } from './common.mjs';

export const INSTALL_DOC = 'docs/INSTALLATION.md#windows-wsl2';

export const PLATFORM_UNSUPPORTED_MESSAGE = [
  'Build Loop does not run on native Windows. Use WSL2 instead.',
  'WSL2 is a real Linux system that runs inside Windows, built in by Microsoft.',
  'To get going:',
  '  1. In PowerShell (as administrator): wsl --install',
  '  2. Inside WSL: install Node 22, git, jq and perl (for example: sudo apt install git jq perl, then Node 22 from nodejs.org or nvm).',
  '  3. Inside WSL: clone the repository into the Linux file system, for example ~/projects, not under /mnt/c.',
  `Details: ${INSTALL_DOC}`,
].join('\n');

export const ROOT_ON_WINDOWS_DRIVE_MESSAGE = [
  'This folder is on a Windows drive (under /mnt/). Build Loop refuses it inside WSL.',
  'That drive type (DrvFs) does not keep the file permission and link rules the loop relies on for safe locks and records, and it is slow.',
  'Move or clone the project into the Linux file system, for example ~/projects/<name>, and use that path.',
  `Details: ${INSTALL_DOC}`,
].join('\n');

function readText(file) { try { return readFileSync(file, 'utf8'); } catch { return ''; } }

// Tests only. Both switches can only add refusals, never remove one.
function testWsl(env) { return env.BUILD_LOOP_TEST_WSL === '1'; }

export function detectPlatform({ platform = process.platform, env = process.env, procVersion } = {}) {
  const os = env.BUILD_LOOP_TEST_PLATFORM === 'win32' ? 'win32' : platform;
  const version = os === 'linux' ? (procVersion ?? readText('/proc/version')) : '';
  const wsl = os === 'linux' && (/microsoft/i.test(version) || Boolean(env.WSL_DISTRO_NAME) || testWsl(env));
  if (os === 'win32') return { os, wsl: false, supported: false, reason: 'native Windows is not supported; use WSL2' };
  if (os === 'darwin') return { os, wsl: testWsl(env), supported: true, reason: testWsl(env) ? 'macOS (test: simulating WSL2)' : 'macOS' };
  if (os === 'linux') return { os, wsl, supported: true, reason: wsl ? 'Linux under WSL2 (experimental)' : 'Linux' };
  return { os, wsl: false, supported: true, reason: `untested platform: ${os}` };
}

export function assertPlatformSupported(info = detectPlatform()) {
  if (!info.supported) throw new ControlError('PLATFORM_UNSUPPORTED', PLATFORM_UNSUPPORTED_MESSAGE, { docs: INSTALL_DOC });
  return info;
}

// Mount points of Windows drives, read from /proc/mounts (drvfs, or 9p which
// WSL2 uses for the same drives). Spaces are escaped as \040 there.
function windowsMounts(mounts) {
  return mounts.split('\n').map((line) => line.split(' ')).filter((field) => field.length > 2 && ['drvfs', '9p'].includes(field[2]))
    .map((field) => field[1].replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8))));
}

function under(child, parent) {
  if (parent === '/') return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// True when a path is on a Windows drive as seen from WSL. Only meaningful
// under WSL; elsewhere /mnt/c is an ordinary Linux folder.
export function isWindowsDrivePath(candidate, { wsl, mounts, env = process.env } = {}) {
  if (!wsl || typeof candidate !== 'string') return false;
  const target = path.resolve(candidate);
  if (/^\/mnt\/[a-zA-Z](\/|$)/.test(target)) return true;
  if (windowsMounts(mounts ?? readText('/proc/mounts')).some((mount) => under(target, mount))) return true;
  const extra = testWsl(env) ? env.BUILD_LOOP_TEST_DRIVE_ROOT : '';
  if (!extra || !path.isAbsolute(extra)) return false;
  let extraReal = path.resolve(extra); let targetReal = target;
  try { extraReal = realpathSync(extraReal); } catch {}
  try { targetReal = realpathSync(target); } catch {}
  return under(target, path.resolve(extra)) || under(targetReal, extraReal);
}

export function assertRootNotOnWindowsDrive(root, info = detectPlatform(), options = {}) {
  if (isWindowsDrivePath(root, { wsl: info.wsl, ...options })) throw new ControlError('ROOT_ON_WINDOWS_DRIVE', ROOT_ON_WINDOWS_DRIVE_MESSAGE, { docs: INSTALL_DOC });
}

// The single guard every entry point calls first: refuses native Windows,
// and under WSL any root on a Windows drive. Returns null when all is well.
export function platformProblem(root = null, info = detectPlatform()) {
  try {
    assertPlatformSupported(info);
    if (root) assertRootNotOnWindowsDrive(root, info);
    return null;
  } catch (error) {
    if (error instanceof ControlError) return { code: error.code, message: error.message, docs: INSTALL_DOC };
    throw error;
  }
}

// Script use: node control/platform.mjs check [PATH ...]
// Prints one line per finding; exits 0 when fine, 69 otherwise.
function main(argv) {
  if (argv[0] !== 'check') { process.stderr.write('Usage: node control/platform.mjs check [PATH ...]\n'); return 64; }
  const info = detectPlatform();
  if (info.wsl) process.stdout.write('WSL2 detected: Windows support through WSL2 is experimental.\n');
  let problem = platformProblem(null, info);
  for (const candidate of argv.slice(1)) {
    if (problem) break;
    let resolved = candidate; try { resolved = realpathSync(candidate); } catch { resolved = path.resolve(candidate); }
    problem = platformProblem(resolved, info);
    if (problem) problem = { ...problem, message: `${resolved}: ${problem.message}` };
  }
  if (problem) { process.stderr.write(`${problem.code}: ${problem.message}\n`); return 69; }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
