import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPlatformSupported, assertRootNotOnWindowsDrive, detectPlatform, isWindowsDrivePath, platformProblem } from '../control/platform.mjs';
import { resolveRoot } from '../control/common.mjs';
import { createHandler } from '../mcp/server.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cleanEnv = () => { const env = { ...process.env }; for (const name of ['WSL_DISTRO_NAME', 'BUILD_LOOP_TEST_WSL', 'BUILD_LOOP_TEST_PLATFORM', 'BUILD_LOOP_TEST_DRIVE_ROOT']) delete env[name]; return env; };
const run = (args, options = {}) => spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 60000, ...options, env: { ...cleanEnv(), ...(options.env || {}) } });
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'platform-test', version: '1' } } };

test('detectPlatform tells macOS, Linux, WSL and native Windows apart', () => {
  assert.deepEqual(detectPlatform({ platform: 'darwin', env: {} }), { os: 'darwin', wsl: false, supported: true, reason: 'macOS' });
  const linux = detectPlatform({ platform: 'linux', env: {}, procVersion: 'Linux version 6.8.0-generic (gcc)' });
  assert.equal(linux.wsl, false); assert.equal(linux.supported, true);
  const wsl = detectPlatform({ platform: 'linux', env: {}, procVersion: 'Linux version 5.15.153.1-microsoft-standard-WSL2' });
  assert.equal(wsl.wsl, true); assert.equal(wsl.supported, true);
  assert.equal(detectPlatform({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, procVersion: 'Linux version 6.8.0' }).wsl, true);
  const windows = detectPlatform({ platform: 'win32', env: {} });
  assert.equal(windows.supported, false); assert.equal(windows.wsl, false);
  assert.throws(() => assertPlatformSupported(windows), (error) => error.code === 'PLATFORM_UNSUPPORTED' && /wsl --install/.test(error.message) && /INSTALLATION\.md#windows-wsl2/.test(error.message));
  assert.equal(detectPlatform({ platform: 'linux', env: { BUILD_LOOP_TEST_PLATFORM: 'win32' } }).supported, false);
});

test('a Windows drive is refused only under WSL', () => {
  assert.equal(isWindowsDrivePath('/mnt/c/Users/example/project', { wsl: true, mounts: '' }), true);
  assert.equal(isWindowsDrivePath('/mnt/D', { wsl: true, mounts: '' }), true);
  assert.equal(isWindowsDrivePath('/mnt/c/Users/example/project', { wsl: false, mounts: '' }), false);
  assert.equal(isWindowsDrivePath('/home/user/projects/app', { wsl: true, mounts: '' }), false);
  assert.equal(isWindowsDrivePath('/mnt/wslg/x', { wsl: true, mounts: '' }), false);
  assert.equal(isWindowsDrivePath('/win/e/project', { wsl: true, mounts: 'E:\\134 /win/e 9p rw 0 0\n' }), true);
  assert.equal(isWindowsDrivePath('/data/My\u0020Drive/x', { wsl: true, mounts: 'X: /data/My\\040Drive drvfs rw 0 0\n' }), true);
  assert.throws(() => assertRootNotOnWindowsDrive('/mnt/c/x', { wsl: true }, { mounts: '' }), (error) => error.code === 'ROOT_ON_WINDOWS_DRIVE' && /DrvFs/.test(error.message));
  assert.equal(platformProblem('/mnt/c/x', { os: 'linux', wsl: true, supported: true }).code, 'ROOT_ON_WINDOWS_DRIVE');
  assert.equal(platformProblem('/home/user/p', { os: 'linux', wsl: true, supported: true }), null);
});

test('resolveRoot refuses a root on a simulated Windows drive under WSL', async () => {
  const drive = mkdtempSync(join(tmpdir(), 'loop-drive-')); const project = join(drive, 'project'); mkdirSync(project);
  const saved = { wsl: process.env.BUILD_LOOP_TEST_WSL, drive: process.env.BUILD_LOOP_TEST_DRIVE_ROOT };
  try {
    assert.ok(await resolveRoot(project));
    process.env.BUILD_LOOP_TEST_WSL = '1'; process.env.BUILD_LOOP_TEST_DRIVE_ROOT = drive;
    await assert.rejects(resolveRoot(project), (error) => error.code === 'ROOT_ON_WINDOWS_DRIVE');
    const cli = run(['bin/build-loop.mjs', 'inspect', '--root', project, '--json'], { env: { BUILD_LOOP_TEST_WSL: '1', BUILD_LOOP_TEST_DRIVE_ROOT: drive } });
    assert.equal(JSON.parse(cli.stdout).error.code, 'ROOT_ON_WINDOWS_DRIVE');
    const prereq = spawnSync('bash', ['bootstrap/check-prerequisites.sh', project], { cwd: repo, encoding: 'utf8', env: { ...cleanEnv(), BUILD_LOOP_TEST_WSL: '1', BUILD_LOOP_TEST_DRIVE_ROOT: drive } });
    assert.equal(prereq.status, 69); assert.match(prereq.stdout, /WSL2 detected/); assert.match(prereq.stderr, /ROOT_ON_WINDOWS_DRIVE/);
    const mcp = run(['bin/build-loop-mcp.mjs', '--root', project], { input: `${JSON.stringify(initialize)}\n`, env: { BUILD_LOOP_TEST_WSL: '1', BUILD_LOOP_TEST_DRIVE_ROOT: drive } });
    const reply = JSON.parse(mcp.stdout.trim());
    assert.equal(reply.error.data.code, 'ROOT_ON_WINDOWS_DRIVE');
  } finally {
    for (const [name, value] of [['BUILD_LOOP_TEST_WSL', saved.wsl], ['BUILD_LOOP_TEST_DRIVE_ROOT', saved.drive]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(drive, { recursive: true, force: true });
  }
});

test('the CLI refuses native Windows before anything else', () => {
  const source = readFileSync(join(repo, 'bin/build-loop.mjs'), 'utf8');
  assert.ok(source.indexOf('platformProblem()') < source.indexOf('process.argv.slice(2)'), 'the guard must run before argument parsing');
  for (const args of [['inspect', '--root', tmpdir(), '--json'], ['serve', '--root', tmpdir()], []]) {
    const result = run(['bin/build-loop.mjs', ...args], { env: { BUILD_LOOP_TEST_PLATFORM: 'win32' } });
    assert.equal(result.status, 69, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'PLATFORM_UNSUPPORTED');
    assert.match(result.stderr, /WSL2/);
  }
});

test('the MCP server answers with a JSON-RPC error on native Windows instead of crashing', async () => {
  const handle = createHandler({ root: null, operations: {}, dispatch: null, requestApproval: null, unavailable: platformProblem(null, { os: 'win32', wsl: false, supported: false }) });
  const reply = await handle(initialize);
  assert.equal(reply.id, 1); assert.equal(reply.error.code, -32001); assert.equal(reply.error.data.code, 'PLATFORM_UNSUPPORTED'); assert.match(reply.error.message, /wsl --install/);
  assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'loop_inspect', arguments: {} } })).error.data.code, 'PLATFORM_UNSUPPORTED');
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
  const input = [initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }].map(JSON.stringify).join('\n') + '\n';
  const result = run(['bin/build-loop-mcp.mjs', '--root', tmpdir()], { input, env: { BUILD_LOOP_TEST_PLATFORM: 'win32' } });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 2);
  for (const each of replies) assert.equal(each.error.data.code, 'PLATFORM_UNSUPPORTED');
});
