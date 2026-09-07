#!/usr/bin/env node
// Package only declared runtime inputs. Never copy a checkout or a user's .loop.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, join, basename, relative as relativePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { operations } from '../control/index.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const targets = [join(dist, 'desktop'), join(dist, 'codex', 'build-loop')];
const runtime = ['bin', 'control', 'mcp', 'engine', 'bootstrap', 'core', 'spec', 'hosts', 'profiles', 'template', 'examples', 'docs', 'tests/fixtures', 'VERSION', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md'];
function copy(relative, destination) {
  const source = join(root, relative);
  if (!existsSync(source)) throw new Error(`Missing package input: ${relative}`);
  const check = path => {
    const info = lstatSync(path), name = basename(path), rel = relativePath(root, path).split('\\').join('/');
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in package input: ${rel}`);
    if (['.git', 'node_modules', '.DS_Store'].includes(name) || (name === '.loop' && rel !== 'template/.loop') || /^\.env(?:\.|$)/.test(name) || /\.(?:log|pem|key)$/.test(name)) throw new Error(`Refusing private or generated package input: ${rel}`);
    if (info.isDirectory()) for (const child of readdirSync(path)) check(join(path, child));
  };
  check(source); mkdirSync(dirname(join(destination, relative)), { recursive: true }); cpSync(source, join(destination, relative), { recursive: true });
}
for (const destination of targets) {
  rmSync(destination, { recursive: true, force: true }); mkdirSync(destination, { recursive: true });
  for (const relative of runtime) copy(relative, destination);
  if (existsSync(join(root, 'LICENSE'))) copy('LICENSE', destination);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'))); delete pkg.scripts; delete pkg.files;
  writeFileSync(join(destination, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
const desktopManifest = JSON.parse(readFileSync(join(root, 'integrations/claude-desktop/manifest.json')));
desktopManifest.version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
desktopManifest.tools_generated = false;
desktopManifest.tools = [...Object.entries(operations).map(([name, tool]) => ({ name: `loop_${name}`, description: tool.description })),
  { name: 'loop_request_approval', description: 'Open a local human review of the current setup plan. Return the link to the user; never approve it yourself.' }];
writeFileSync(join(targets[0], 'manifest.json'), `${JSON.stringify(desktopManifest, null, 2)}\n`);
mkdirSync(join(targets[1], '.codex-plugin'), { recursive: true });
cpSync(join(root, 'integrations/codex/build-loop/.codex-plugin/plugin.json'), join(targets[1], '.codex-plugin/plugin.json'));
mkdirSync(join(targets[1], 'skills/build-loop'), { recursive: true });
cpSync(join(root, '.agents/skills/build-loop/SKILL.md'), join(targets[1], 'skills/build-loop/SKILL.md'));
writeFileSync(join(dist, 'codex', 'marketplace.json'), `${JSON.stringify({
  name: 'build-loop-local', interface: { displayName: 'Build Loop Local' },
  plugins: [{ name: 'build-loop', source: { source: 'local', path: './build-loop' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }],
}, null, 2)}\n`);
const archive = join(dist, 'build-loop.mcpb'); rmSync(archive, { force: true });
const result = spawnSync('zip', ['-q', '-r', archive, '.'], { cwd: targets[0], stdio: 'inherit' });
if (result.status !== 0) throw new Error('Packaging needs the zip utility; no bundle was validated.');
console.log(JSON.stringify({ desktop_bundle: archive, codex_plugin: targets[1], note: 'Install locally for host validation. Packaging does not publish or install anything.' }, null, 2));
