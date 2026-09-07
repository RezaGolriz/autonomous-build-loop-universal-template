import { ControlError, exactKeys, intValue, safeRelativeArray, stringArray, stringValue } from './common.mjs';

const relPath = { type: 'string', minLength: 1, maxLength: 1024, pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$' };
const nonEmptyStrings = { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4096 } };
const argvStrings = { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1, maxLength: 4096 } };
const strict = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });

const commandSchema = strict({
  id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
  phase: { enum: ['EXECUTE', 'VALIDATE'] },
  cwd: relPath,
  argv: argvStrings,
  timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400 },
  evidence_types: { ...nonEmptyStrings, contains: { const: 'command' } },
}, ['id', 'phase', 'cwd', 'argv', 'timeout_seconds', 'evidence_types']);

const adapterSchema = strict({
  schema_version: { const: 1 }, adapter_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
  project_kind: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
  target: strict({ languages: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } }, runtimes: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } }, platforms: nonEmptyStrings }, ['languages', 'runtimes', 'platforms']),
  artifacts: { type: 'array', minItems: 1, items: strict({ id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' }, kind: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' }, paths: { type: 'array', minItems: 1, uniqueItems: true, items: relPath } }, ['id', 'kind', 'paths']) },
  commands: { type: 'array', minItems: 1, items: commandSchema },
  validation: strict({ required_evidence: nonEmptyStrings }, ['required_evidence']),
  protected_paths: { type: 'array', minItems: 1, uniqueItems: true, items: relPath },
  environment: strict({ allow_names: { type: 'array', minItems: 1, uniqueItems: true, contains: { const: 'PATH' }, items: { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' } } }, ['allow_names']),
}, ['schema_version', 'adapter_id', 'project_kind', 'target', 'artifacts', 'commands', 'validation', 'protected_paths', 'environment']);

const negativeSchema = strict({
  argv: argvStrings, cwd: relPath, timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400 },
  expected_exit_code: { type: 'integer', minimum: 1, maximum: 255 },
  expected_output: strict({ stream: { enum: ['stdout', 'stderr', 'combined'] }, match: { enum: ['equals', 'includes'] }, value: { type: 'string', minLength: 1, maxLength: 4096 } }, ['stream', 'match', 'value']),
}, ['argv', 'cwd', 'timeout_seconds', 'expected_exit_code', 'expected_output']);

const prepareSchema = strict({
  request: { type: 'string', minLength: 1, maxLength: 20000 },
  acceptance_criteria: nonEmptyStrings, out_of_scope: nonEmptyStrings,
  allowed_paths: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: relPath },
  frozen_paths: { type: 'array', maxItems: 128, uniqueItems: true, items: relPath },
  adapter: adapterSchema,
  adapter_overrides: strict({ platforms: nonEmptyStrings, protected_paths: { type: 'array', minItems: 1, uniqueItems: true, items: relPath }, commands: { type: 'array', minItems: 1, items: commandSchema }, artifacts: { type: 'array', minItems: 1 }, required_evidence: nonEmptyStrings }, []),
  negative_control: negativeSchema,
  work_item_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
  max_rounds: { type: 'integer', minimum: 6, maximum: 500 }, max_gate_failures: { type: 'integer', minimum: 1, maximum: 20 },
  max_wall_seconds: { type: 'integer', minimum: 60, maximum: 604800 }, autonomy: { enum: ['supervised', 'guarded', 'autonomous'] },
  replace_candidate: { type: 'boolean' },
}, ['request', 'acceptance_criteria', 'out_of_scope', 'allowed_paths', 'negative_control']);

export const operations = Object.freeze({
  inspect: { description: 'Read bounded project signals and return recommendations plus precise missing setup inputs.', inputSchema: strict({}, []) },
  doctor: { description: 'Check the control host, active/candidate configuration, provider installation, and authentication without exposing command output.', inputSchema: strict({}, []) },
  demo: { description: 'Create a runnable docs or Python demonstration in an empty selected project root and prepare a paused setup candidate.', inputSchema: strict({ kind: { enum: ['docs', 'python'] } }, ['kind']) },
  configure: { description: 'Persist signed machine-local builder and reviewer providers, resolved CLI paths, and safe default authentication checks for bundled Codex or Claude providers.', inputSchema: strict({ host: { enum: ['codex', 'claude', 'mock'] }, provider_path: { type: 'string', minLength: 1 }, cli_path: { type: 'string', minLength: 1 }, review_host: { enum: ['codex', 'claude', 'mock'] }, review_provider_path: { type: 'string', minLength: 1 }, review_cli_path: { type: 'string', minLength: 1 } }, ['host']) },
  prepare: { description: 'Write a complete paused candidate from explicit intent, bounded paths, a validated adapter or recommendation, and a meaningful negative control.', inputSchema: prepareSchema },
  activate: { description: 'Start a durable activation job using the persisted receipt; it runs digest-bound disposable positive and negative probes and publishes active state only when all gates pass.', inputSchema: strict({}, []) },
  task: { description: 'Prepare the next bounded work item after the previous handover is completed.', inputSchema: strict({ request: { type: 'string', minLength: 1, maxLength: 20000 }, acceptance_criteria: nonEmptyStrings, out_of_scope: nonEmptyStrings, allowed_paths: { type: 'array', minItems: 1, uniqueItems: true, items: relPath }, frozen_paths: { type: 'array', uniqueItems: true, items: relPath }, work_item_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } }, ['request', 'acceptance_criteria', 'out_of_scope', 'allowed_paths']) },
  start: { description: 'Start a finite detached run from PAUSED state.', inputSchema: strict({ request_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, max_nodes: { type: 'integer', minimum: 1, maximum: 500 } }, ['request_id', 'max_nodes']) },
  run: { description: 'Start or continue a finite detached run, executing one engine-owned node per iteration.', inputSchema: strict({ request_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, max_nodes: { type: 'integer', minimum: 1, maximum: 500 } }, ['request_id', 'max_nodes']) },
  status: { description: 'Return canonical engine status plus durable detached-job progress.', inputSchema: strict({ job_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } }, []) },
  answer: { description: 'Record an actual human answer in a structured sidecar and resolve exactly one referenced blocker.', inputSchema: strict({ blocker_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, blocker_index: { type: 'integer', minimum: 1, maximum: 10000 }, answer: { type: 'string', minLength: 1, maxLength: 20000 } }, ['answer']) },
  pause: { description: 'Request that a detached worker finish its current bounded node and then pause.', inputSchema: strict({}, []) },
  cancel: { description: 'Request that a detached worker finish its current bounded node and then cancel.', inputSchema: strict({}, []) },
  resume: { description: 'Resume a PAUSED run, or a BLOCKED run after all blockers are resolved, preserving original time and retry caps.', inputSchema: strict({ request_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, max_nodes: { type: 'integer', minimum: 1, maximum: 500 } }, ['request_id', 'max_nodes']) },
  handover: { description: 'Acknowledge a passed HANDOVER gate or a cancellation and complete the local work item without performing delivery actions.', inputSchema: strict({ note: { type: 'string', minLength: 1, maxLength: 20000 } }, ['note']) },
});

const evidenceKinds = new Set(['acceptance', 'command', 'artifact', 'behavior', 'contract', 'installation', 'package', 'documentation', 'link-check']);

function argvArray(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256 || value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 4096)) throw new ControlError('INVALID_INPUT', `${label} must be a non-empty argv array`);
  return value;
}

function validateCommand(value, label) {
  exactKeys(value, ['id', 'phase', 'cwd', 'argv', 'timeout_seconds', 'evidence_types'], ['id', 'phase', 'cwd', 'argv', 'timeout_seconds', 'evidence_types'], label);
  stringValue(value.id, `${label}.id`, { pattern: /^[a-z][a-z0-9-]*$/ });
  if (!['EXECUTE', 'VALIDATE'].includes(value.phase)) throw new ControlError('INVALID_INPUT', `${label}.phase is invalid`);
  safeRelativeArray([value.cwd], `${label}.cwd`, 1);
  argvArray(value.argv, `${label}.argv`);
  intValue(value.timeout_seconds, `${label}.timeout_seconds`, 1, 86400);
  const types = stringArray(value.evidence_types, `${label}.evidence_types`, { min: 1 });
  if (!types.includes('command') || types.some((kind) => !evidenceKinds.has(kind))) throw new ControlError('INVALID_INPUT', `${label}.evidence_types must use supported kinds and include command`);
}

export function validateAdapter(value, label = 'adapter') {
  exactKeys(value, ['schema_version', 'adapter_id', 'project_kind', 'target', 'artifacts', 'commands', 'validation', 'protected_paths', 'environment'], ['schema_version', 'adapter_id', 'project_kind', 'target', 'artifacts', 'commands', 'validation', 'protected_paths', 'environment'], label);
  if (value.schema_version !== 1) throw new ControlError('INVALID_INPUT', `${label}.schema_version must be 1`);
  stringValue(value.adapter_id, `${label}.adapter_id`, { pattern: /^[a-z][a-z0-9-]{1,63}$/ });
  stringValue(value.project_kind, `${label}.project_kind`, { pattern: /^[a-z][a-z0-9-]{1,63}$/ });
  exactKeys(value.target, ['languages', 'runtimes', 'platforms'], ['languages', 'runtimes', 'platforms'], `${label}.target`);
  stringArray(value.target.languages, `${label}.target.languages`); stringArray(value.target.runtimes, `${label}.target.runtimes`); stringArray(value.target.platforms, `${label}.target.platforms`, { min: 1 });
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) throw new ControlError('INVALID_INPUT', `${label}.artifacts must be non-empty`);
  for (const [index, artifact] of value.artifacts.entries()) {
    exactKeys(artifact, ['id', 'kind', 'paths'], ['id', 'kind', 'paths'], `${label}.artifacts[${index}]`);
    stringValue(artifact.id, 'artifact.id', { pattern: /^[a-z][a-z0-9-]*$/ }); stringValue(artifact.kind, 'artifact.kind', { pattern: /^[a-z][a-z0-9-]*$/ }); safeRelativeArray(artifact.paths, 'artifact.paths', 1);
  }
  if (!Array.isArray(value.commands) || !value.commands.length) throw new ControlError('INVALID_INPUT', `${label}.commands must be non-empty`);
  value.commands.forEach((command, index) => validateCommand(command, `${label}.commands[${index}]`));
  if (new Set(value.commands.map(({ id }) => id)).size !== value.commands.length) throw new ControlError('INVALID_INPUT', `${label}.commands ids must be unique`);
  exactKeys(value.validation, ['required_evidence'], ['required_evidence'], `${label}.validation`);
  const requiredEvidence = stringArray(value.validation.required_evidence, `${label}.validation.required_evidence`, { min: 1 });
  if (requiredEvidence.some((kind) => !evidenceKinds.has(kind))) throw new ControlError('INVALID_INPUT', 'unsupported required evidence kind');
  safeRelativeArray(value.protected_paths, `${label}.protected_paths`, 1);
  exactKeys(value.environment, ['allow_names'], ['allow_names'], `${label}.environment`);
  const names = stringArray(value.environment.allow_names, `${label}.environment.allow_names`, { min: 1, pattern: /^[A-Z_][A-Z0-9_]*$/ });
  if (!names.includes('PATH')) throw new ControlError('INVALID_INPUT', `${label}.environment.allow_names must include PATH`);
  for (const phase of ['EXECUTE', 'VALIDATE']) {
    const available = new Set(value.commands.filter((command) => command.phase === phase).flatMap((command) => command.evidence_types));
    const missing = requiredEvidence.filter((kind) => !available.has(kind));
    if (missing.length) throw new ControlError('INVALID_INPUT', `${label} ${phase} commands do not declare required evidence: ${missing.join(', ')}`);
  }
  return value;
}

export function validateNegative(value) {
  exactKeys(value, ['argv', 'cwd', 'timeout_seconds', 'expected_exit_code', 'expected_output'], ['argv', 'cwd', 'timeout_seconds', 'expected_exit_code', 'expected_output'], 'negative_control');
  argvArray(value.argv, 'negative_control.argv'); safeRelativeArray([value.cwd], 'negative_control.cwd', 1);
  intValue(value.timeout_seconds, 'negative_control.timeout_seconds', 1, 86400); intValue(value.expected_exit_code, 'negative_control.expected_exit_code', 1, 255);
  exactKeys(value.expected_output, ['stream', 'match', 'value'], ['stream', 'match', 'value'], 'negative_control.expected_output');
  if (!['stdout', 'stderr', 'combined'].includes(value.expected_output.stream) || !['equals', 'includes'].includes(value.expected_output.match)) throw new ControlError('INVALID_INPUT', 'negative_control.expected_output is invalid');
  stringValue(value.expected_output.value, 'negative_control.expected_output.value', { max: 4096 });
  return value;
}

export function validateOperation(operation, args) {
  if (!Object.hasOwn(operations, operation)) throw new ControlError('UNKNOWN_OPERATION', `unknown operation: ${operation}`);
  const keys = Object.keys(operations[operation].inputSchema.properties);
  exactKeys(args, keys, operations[operation].inputSchema.required || [], 'args');
  if (Object.hasOwn(args, 'root')) throw new ControlError('UNKNOWN_FIELD', 'root is fixed by the transport and cannot appear in args');
  return args;
}

export { adapterSchema, negativeSchema, prepareSchema };
