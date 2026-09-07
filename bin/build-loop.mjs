#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import process from 'node:process';
import { dispatch, operations, requestApproval } from '../control/index.mjs';
import { approvalSummary, recordTrustedApproval } from '../control/approval.mjs';
import { checkExitCode } from '../control/check.mjs';
import { tickExitCode } from '../control/tick.mjs';
import { resolveRoot } from '../control/common.mjs';
import { verifyPlanForApproval } from '../control/setup.mjs';

// Human-only decisions. Each needs its own literal word, typed at an
// interactive terminal. An explicit input file is not a person: it returns a
// pending request and a local confirmation link instead of completing.
const confirmations = { accept: 'ACCEPT', authorize: 'AUTHORIZE', promote: 'PROMOTE', release: 'RELEASE' };

function usage(message = '') {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: build-loop OP --root PATH [--input FILE] [--json]\n');
  process.stderr.write(`Operations: ${[...Object.keys(operations), 'request-approval', 'approve'].join(', ')}\n`);
  process.exit(64);
}

const ttyText = (value) => String(value).replace(/[\0-\x1f\x7f]/g, (char) => `\\x${char.codePointAt(0).toString(16).padStart(2, '0')}`);
const ttyList = (values) => values.map(ttyText).join(', ');

const argv = process.argv.slice(2); const operation = argv.shift(); if (!operation) usage();
let root = null; let inputFile = null; let json = false;
while (argv.length) {
  const flag = argv.shift();
  if (flag === '--root') root = argv.shift() || usage('--root requires a value');
  else if (flag === '--input') inputFile = argv.shift() || usage('--input requires a value');
  else if (flag === '--json') json = true;
  else usage(`unknown argument: ${flag}`);
}
if (!root) usage('--root is required');
let input = {};
if (inputFile) {
  // --input normally names a JSON file. A value that already starts with { is
  // read as the JSON object itself, which keeps a scheduled one-liner readable.
  try { input = JSON.parse(inputFile.trimStart().startsWith('{') ? inputFile : await fs.readFile(inputFile, 'utf8')); }
  catch (error) { process.stderr.write(`Invalid input JSON: ${error.message}\n`); process.exit(65); }
}
let result;
if (operation === 'request-approval') result = await requestApproval(root, input);
else if (operation === 'approve') {
  if (inputFile) usage('approve does not accept --input');
  if (!process.stdin.isTTY || !process.stdout.isTTY) { result = { ok: false, error: { code: 'TTY_REQUIRED', message: 'approve requires an interactive TTY; use request-approval for local HTTP confirmation' } }; }
  else {
    try {
      root = await resolveRoot(root); const plan = await verifyPlanForApproval(root); const summary = await approvalSummary(root, plan);
      process.stdout.write(`Project root: ${ttyText(root)}\nWork kind: ${ttyText(summary.work_kind)}\nRequest: ${ttyText(summary.request)}\nTarget: ${ttyList(summary.target.languages)}; ${ttyList(summary.target.runtimes)}; ${ttyList(summary.target.platforms)}\nProvider: ${summary.provider ? `${ttyText(summary.provider.host)} (${ttyText(summary.provider.provider_path)}); review ${ttyText(summary.provider.review_host)} (${ttyText(summary.provider.review_provider_path)})` : 'not configured'}\nAcceptance criteria: ${ttyList(summary.acceptance_criteria)}\nOut of scope: ${ttyList(summary.out_of_scope)}\nAllowed paths: ${ttyList(summary.allowed_paths)}\nFrozen paths: ${ttyList(summary.frozen_paths) || 'none'}\nProtected paths: ${ttyList(summary.protected_paths)}\nEnvironment names: ${ttyList(summary.environment_names) || 'none'}\nRequired evidence: ${ttyList(summary.required_evidence)}\nCommands:\n${summary.commands.map((command) => `  ${ttyText(command.phase)}/${ttyText(command.id)}: ${ttyList(command.argv)} (cwd ${ttyText(command.cwd)}, ${command.timeout_seconds}s, evidence ${ttyList(command.evidence_types)})`).join('\n')}\nNegative probe: ${ttyList(summary.negative_control.argv)} (cwd ${ttyText(summary.negative_control.cwd)}, expected exit ${summary.negative_control.expected_exit_code})\nLimits: ${summary.limits.max_rounds} rounds, ${summary.limits.max_gate_failures} gate failures, ${summary.limits.max_wall_seconds}s, ${ttyText(summary.limits.autonomy)}\nSetup digest: ${ttyText(plan.setup_digest)}\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout }); const answer = await rl.question('Type APPROVE to authorize this displayed setup: '); rl.close();
      result = answer === 'APPROVE' ? { ok: true, approval: await recordTrustedApproval(root, plan.setup_digest, 'interactive-tty') } : { ok: false, error: { code: 'APPROVAL_MISMATCH', message: 'approval phrase did not match; nothing was approved' } };
    } catch (error) { result = { ok: false, error: { code: error.code || 'APPROVAL_FAILED', message: error.message } }; }
  }
} else if (Object.hasOwn(confirmations, operation)) {
  const word = confirmations[operation];
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // No terminal, so nobody typed anything. The decision is not completed
    // here: it becomes a pending request with a local confirmation link.
    result = await dispatch(root, operation, input, { channel: 'cli-input' });
  } else {
    process.stdout.write(`Project root: ${ttyText(root)}\nOperation: ${ttyText(operation)}\nThis is a human decision. It is recorded with the local time and the channel you used.\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Type ${word} to confirm: `);
    rl.close();
    result = answer === word
      ? await dispatch(root, operation, operation === 'promote' ? input : { ...input, confirm: word }, { channel: 'interactive-tty' })
      : { ok: false, error: { code: 'CONFIRMATION_MISMATCH', message: `confirmation phrase did not match; nothing was ${{ accept: 'accepted', promote: 'promoted', release: 'released', authorize: 'authorized' }[operation]}` } };
  }
} else if (operation === 'discard') {
  // Triage is a deliberate call rather than a typed confirmation, but the
  // record still keeps which boundary the decision came through.
  result = await dispatch(root, operation, input, { channel: 'cli-input' });
} else {
  // Everything else, execution included. A real terminal session is a person;
  // a command line without one is a script, a scheduler or an agent, and start,
  // run and resume treat the two differently once an item's authorization has
  // been withdrawn.
  result = await dispatch(root, operation, input, { channel: process.stdin.isTTY && process.stdout.isTTY ? 'interactive-tty' : 'cli-input' });
}

process.stdout.write(`${JSON.stringify(result, null, json ? 2 : 0)}\n`);
if (operation === 'check') process.exitCode = checkExitCode(result);
else if (operation === 'tick') process.exitCode = tickExitCode(result);
else if (!result.ok) process.exitCode = 1;
