// The only tools a managed API member can call: list_files, read_file and
// write_file, confined to the project root. No tool starts a process, reads
// the environment, or follows a symlink.
//
// Reading needs the tool in the member's tool_scope and a path inside its
// read_paths. Writing additionally needs a builder, a phase that changes
// something (DEFINE, DESIGN, EXECUTE, HANDOVER), a path inside the member's
// write_paths and the node's allowed_paths, and outside the node's frozen
// paths and the adapter's protected paths. Runner-owned .loop records, .git
// and files that usually hold secrets are never read or written. For DEFINE,
// DESIGN and HANDOVER the only .loop file that may be written is the work item
// itself, exactly as the brief says. The orchestrator still checks every
// changed path after the node; these checks keep a model from trying.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const WRITE_PHASES = Object.freeze(['DEFINE', 'DESIGN', 'EXECUTE', 'HANDOVER']);
const WORK_ITEM_PHASES = ['DEFINE', 'DESIGN', 'HANDOVER'];
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_LIST_DEPTH = 8;

// Readable .loop records: the work item, notes and the plain state. The rest
// (control, scheduler, candidate, evidence, locks, quarantine) is runner-owned.
const LOOP_READABLE = ['.loop/work-items/**', '.loop/notes/**', '.loop/state.json', '.loop/project.adapter.json', '.loop/workflow.json'];
const SECRET_NAMES = [/^\.env(?:\..*)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /^id_(?:rsa|dsa|ecdsa|ed25519)/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i, /credentials/i, /secret/i];
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.docker', '.kube'];

export class ToolError extends Error {}

const escape = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

// `**` spans directories, `*` and `?` stay inside one segment. With loose, `*`
// spans directories too, the way the engine's own bash [[ == ]] test reads a
// pattern; deny lists use that so they never protect less than the engine.
export function globRegex(pattern, { loose = false } = {}) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
    } else if (c === '*') out += loose ? '.*' : '[^/]*';
    else if (c === '?') out += loose ? '.' : '[^/]';
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

// A pattern also covers everything under a directory it names, as in the engine.
export function matchesAny(rel, patterns, options) {
  return patterns.some((pattern) => {
    if (rel === pattern) return true;
    const prefix = pattern.replace(/\/(?:\*\*|\*)?$/, '');
    if (prefix && !/[*?]/.test(prefix) && (rel === prefix || rel.startsWith(`${prefix}/`))) return true;
    return globRegex(pattern, options).test(rel);
  });
}

export function normalizeRel(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new ToolError('path must be a non-empty repository-relative string');
  if (/[\0-\x1f\x7f]/.test(value) || value.includes('\\')) throw new ToolError('path contains control characters or backslashes');
  if (path.isAbsolute(value)) throw new ToolError('path must be relative to the project root');
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new ToolError('path must not contain ..');
  return parts.join('/') || '.';
}

function secretLike(rel) {
  const parts = rel.split('/');
  if (parts.some((part) => SECRET_DIRS.includes(part))) return true;
  return SECRET_NAMES.some((pattern) => pattern.test(parts[parts.length - 1]));
}

// Directories under .loop a listing may enter.
function listableLoop(rel) {
  if (rel !== '.loop' && !rel.startsWith('.loop/')) return true;
  return rel === '.loop' || ['.loop/work-items', '.loop/notes'].some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

function alwaysDenied(rel) {
  if (rel === '.git' || rel.startsWith('.git/')) return 'the .git directory is never available to a member';
  if (secretLike(rel)) return 'files that usually hold secrets are never available to a member';
  return null;
}

// Every existing component has to be a real directory (or, last, a regular
// file) inside the root. A symlink anywhere is refused rather than followed.
async function assertNoSymlink(root, rel, { allowMissing }) {
  let current = root;
  const parts = rel === '.' ? [] : rel.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) { if (allowMissing) return; throw new ToolError(`no such path: ${rel}`); }
    if (stat.isSymbolicLink()) throw new ToolError(`refusing a symlink: ${parts.slice(0, index + 1).join('/')}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new ToolError(`not a directory: ${parts.slice(0, index + 1).join('/')}`);
  }
}

export function createToolbox({ root, member, brief, protectedPaths = [] }) {
  const phase = brief.phase;
  const tools = new Set(member.tool_scope);
  const workItemFile = `.loop/work-items/${brief.work_item_id}.md`;
  const allowedPaths = Array.isArray(brief.allowed_paths) ? brief.allowed_paths : [];
  const frozenPaths = Array.isArray(brief.frozen_paths) ? brief.frozen_paths : [];

  function readProblem(rel) {
    const denied = alwaysDenied(rel);
    if (denied) return denied;
    if ((rel === '.loop' || rel.startsWith('.loop/')) && !matchesAny(rel, LOOP_READABLE)) return 'runner-owned .loop records are not readable';
    if (!matchesAny(rel, member.data_scope.read_paths)) return 'path is outside this member\'s read_paths';
    return null;
  }

  function writeProblem(rel) {
    if (!tools.has('write_file') || member.role !== 'builder') return 'this member is read-only';
    if (!WRITE_PHASES.includes(phase)) return `${phase} changes nothing`;
    const denied = alwaysDenied(rel);
    if (denied) return denied;
    const isWorkItem = rel === workItemFile;
    if (rel === '.loop' || rel.startsWith('.loop/')) {
      if (!(isWorkItem && WORK_ITEM_PHASES.includes(phase))) return 'the only .loop file a member may write is the work item, in DEFINE, DESIGN or HANDOVER';
    } else if (WORK_ITEM_PHASES.includes(phase)) return `${phase} edits only the work item file ${workItemFile}`;
    // The work item edit belongs to the builder role in those phases; product
    // paths also need the member's own write_paths.
    if (!isWorkItem && !matchesAny(rel, member.data_scope.write_paths)) return 'path is outside this member\'s write_paths';
    if (!matchesAny(rel, allowedPaths)) return 'path is outside the node\'s allowed paths';
    if (matchesAny(rel, frozenPaths, { loose: true })) return 'path is frozen for this node';
    if (!isWorkItem && matchesAny(rel, protectedPaths, { loose: true })) return 'path is protected by the project adapter';
    return null;
  }

  async function listFiles(args) {
    const start = normalizeRel(args?.path ?? '.');
    const denied = alwaysDenied(start) || (listableLoop(start) ? null : 'runner-owned .loop records are not readable');
    if (denied) throw new ToolError(`${denied}: ${start}`);
    await assertNoSymlink(root, start, { allowMissing: false });
    const entries = []; let truncated = false;
    async function walk(rel, depth) {
      if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
      const dirents = await fs.readdir(rel === '.' ? root : path.join(root, rel), { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
        const child = rel === '.' ? dirent.name : `${rel}/${dirent.name}`;
        if (dirent.isSymbolicLink() || alwaysDenied(child)) continue;
        if (dirent.isDirectory()) {
          if (!listableLoop(child)) continue;
          if (child === 'node_modules' || child.endsWith('/node_modules')) continue;
          if (depth < MAX_LIST_DEPTH) await walk(child, depth + 1);
        } else if (dirent.isFile() && !readProblem(child)) entries.push(child);
      }
    }
    const stat = await fs.lstat(start === '.' ? root : path.join(root, start));
    if (!stat.isDirectory()) throw new ToolError(`not a directory: ${start}`);
    await walk(start, 0);
    return JSON.stringify({ files: entries, truncated });
  }

  async function readFile(args) {
    const rel = normalizeRel(args?.path);
    const problem = readProblem(rel); if (problem) throw new ToolError(`${problem}: ${rel}`);
    await assertNoSymlink(root, rel, { allowMissing: false });
    const file = path.join(root, rel);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new ToolError(`not a regular file: ${rel}`);
    if (stat.size > MAX_READ_BYTES) throw new ToolError(`file is larger than ${MAX_READ_BYTES} bytes: ${rel}`);
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) throw new ToolError(`binary file: ${rel}`);
    return bytes.toString('utf8');
  }

  async function writeFile(args) {
    const rel = normalizeRel(args?.path);
    if (typeof args?.content !== 'string') throw new ToolError('content must be a string');
    if (Buffer.byteLength(args.content) > MAX_WRITE_BYTES) throw new ToolError(`content is larger than ${MAX_WRITE_BYTES} bytes`);
    const problem = writeProblem(rel); if (problem) throw new ToolError(`${problem}: ${rel}`);
    await assertNoSymlink(root, rel, { allowMissing: true });
    const file = path.join(root, rel);
    const existing = await fs.lstat(file).catch(() => null);
    if (existing && !existing.isFile()) throw new ToolError(`not a regular file: ${rel}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // mkdir may have raced with a symlink; check again before writing.
    await assertNoSymlink(root, path.posix.dirname(rel), { allowMissing: false });
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.api-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(temp, args.content, { flag: 'wx', mode: existing ? existing.mode & 0o777 : 0o644 });
    await fs.rename(temp, file);
    return JSON.stringify({ written: rel, bytes: Buffer.byteLength(args.content) });
  }

  const all = {
    list_files: { run: listFiles, description: 'List readable files under a project directory (relative path, default the project root).', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] } },
    read_file: { run: readFile, description: 'Read one UTF-8 text file by project-relative path.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] } },
    write_file: { run: writeFile, description: 'Create or replace one text file by project-relative path. Only allowed paths for this node are accepted.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  };
  // A read-only phase or member is not even offered write_file.
  const offered = Object.keys(all).filter((name) => tools.has(name) && (name !== 'write_file' || (member.role === 'builder' && WRITE_PHASES.includes(phase))));
  return {
    definitions: offered.map((name) => ({ name, description: all[name].description, parameters: all[name].parameters })),
    async call(name, args) {
      if (!offered.includes(name)) return { ok: false, output: `tool ${String(name).slice(0, 64)} is not available to this member in ${phase}` };
      try { return { ok: true, output: await all[name].run(args) }; }
      catch (error) { return { ok: false, output: error instanceof ToolError ? error.message : `tool failed: ${error.code || 'error'}` }; }
    },
    readProblem, writeProblem,
  };
}
