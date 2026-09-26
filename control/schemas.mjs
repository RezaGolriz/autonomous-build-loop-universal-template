import { validateKind, workKinds } from './loop-options.mjs';
import { ControlError, exactKeys, intValue, safeRelativeArray, stringArray, stringValue } from './common.mjs';

const relPath = { type: 'string', minLength: 1, maxLength: 1024, pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$' };
const nonEmptyStrings = { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4096 } };
const argvStrings = { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1, maxLength: 4096 } };
const strict = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
// Provider model per phase: `default` applies to every phase without its own entry.
export const MODEL_KEYS = Object.freeze(['default', 'DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER', 'SCOUT']);
export const MODEL_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:\\[\\]-]{0,79}$';
const modelName = { type: 'string', pattern: MODEL_NAME_PATTERN };

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

// RFC 3339 with a real offset or Z. A timestamp that cannot be parsed is not a
// timestamp: an authorization whose expiry cannot be read grants nothing.
const rfc3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const rfc3339Parts = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

// Date.parse on its own is not a calendar check: it silently rolls an
// impossible date over (2099-02-30 becomes the 2nd of March) and reads hour 24
// as midnight of the next day. A date that does not come back as the fields it
// was written with was never that date, so it is refused here instead of being
// turned into a different moment nobody wrote down.
function timestampValue(value, label) {
  const refuse = () => { throw new ControlError('INVALID_INPUT', `${label} must be an RFC 3339 timestamp`); };
  stringValue(value, label, { max: 64 });
  const parts = rfc3339.test(value) ? rfc3339Parts.exec(value) : null;
  if (!parts) refuse();
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const offsetHours = parts[8] === undefined ? 0 : Number(parts[8]);
  const offsetMinutes = parts[9] === undefined ? 0 : Number(parts[9]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) refuse();
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) refuse();
  if (!Number.isFinite(Date.parse(value))) refuse();
  return value;
}

const workKindSchema = { enum: Object.keys(workKinds) };
const itemIdSchema = { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const proposalIdSchema = { type: 'string', pattern: '^P-\\d{8}T\\d{6}Z-\\d{1,3}$' };
// Channels a decision can be recorded under. `interactive-tty` is a word typed
// at a real terminal and `local-http-user` is a confirmation pressed on the
// local page; the other two are transports that may only ask for one.
const authorizationChannels = ['interactive-tty', 'local-http-user', 'cli-input', 'mcp-user'];
const transportChannels = ['interactive-tty', 'cli-input', 'mcp-user'];
const authorizationSchema = strict({
  schema_version: { const: 1 },
  item_id: itemIdSchema,
  state: { enum: ['PAUSED', 'READY'] },
  scope: strict({ allowed_paths: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: relPath } }, ['allowed_paths']),
  budget: strict({ max_rounds: { type: 'integer', minimum: 1, maximum: 500 }, max_wall_seconds: { type: 'integer', minimum: 60, maximum: 604800 } }, ['max_rounds', 'max_wall_seconds']),
  expires_at: { type: 'string', minLength: 20, maxLength: 64, pattern: rfc3339.source },
  stop_on_first_failure: { type: 'boolean' },
  authorized_by: { enum: authorizationChannels },
  assurance: { enum: ['local-user-action'] },
  authorized_at: { type: 'string', minLength: 20, maxLength: 64, pattern: rfc3339.source },
  note: { type: 'string', minLength: 1, maxLength: 20000 },
}, ['schema_version', 'item_id', 'state', 'authorized_by', 'authorized_at']);

// A project-wide hold. One record, written when somebody stops the project, and
// removed only by a person. See control/hold.mjs.
const holdSchema = strict({
  schema_version: { const: 1 },
  held_at: { type: 'string', minLength: 20, maxLength: 64, pattern: rfc3339.source },
  held_by: { enum: authorizationChannels },
  reason: { type: 'string', minLength: 1, maxLength: 4000 },
  item_id: { anyOf: [itemIdSchema, { type: 'null' }] },
}, ['schema_version', 'held_at', 'held_by', 'reason', 'item_id']);

const prepareSchema = strict({
  work_kind: workKindSchema,
  request: { type: 'string', minLength: 1, maxLength: 20000 },
  acceptance_criteria: nonEmptyStrings, out_of_scope: nonEmptyStrings,
  allowed_paths: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: relPath },
  frozen_paths: { type: 'array', maxItems: 128, uniqueItems: true, items: relPath },
  adapter: adapterSchema,
  adapter_overrides: strict({ platforms: nonEmptyStrings, protected_paths: { type: 'array', minItems: 1, uniqueItems: true, items: relPath }, commands: { type: 'array', minItems: 1, items: commandSchema }, artifacts: { type: 'array', minItems: 1 }, required_evidence: nonEmptyStrings }, []),
  negative_control: negativeSchema,
  work_item_id: itemIdSchema,
  max_rounds: { type: 'integer', minimum: 6, maximum: 500 }, max_gate_failures: { type: 'integer', minimum: 1, maximum: 20 },
  max_wall_seconds: { type: 'integer', minimum: 60, maximum: 604800 }, autonomy: { enum: ['supervised', 'guarded', 'autonomous'] },
  replace_candidate: { type: 'boolean' },
}, ['request', 'acceptance_criteria', 'out_of_scope', 'allowed_paths', 'negative_control']);

export const operations = Object.freeze({
  options: { description: 'List supported work kinds and step or bounded run modes. All retain mandatory review and validation.', inputSchema: strict({}, []) },
  dashboard: { description: 'Return a browser link to the project dashboard. When .loop/control/policy.json sets confirmation_page, or the control page (loop_serve) is already running, this starts or returns the long-lived control page: the dashboard plus a decisions panel where a person types the decision word. For the control page the link is single-use (once, within 10 minutes) and never carries the durable access token. Otherwise it opens the short-lived read-only dashboard. Hand the link to the person; never open it or submit anything on it yourself.', inputSchema: strict({}, []) },
  serve: { description: 'Start the long-lived local control page for this project, or return it when it is already running, and return its link. The page shows the dashboard and a decisions panel: pending accept, authorize, promote and release requests with their frozen summary, and buttons to prepare such a decision. It is read-only until a person types the decision word on it; nothing is decided by starting it. The link is single-use: it opens the page once, within 10 minutes, and the browser then keeps a 12-hour session; call again for a fresh one. The durable access token is never returned here; a person prints its link only at their own terminal (build-loop serve --show-link). Hand the link to the person; never open it or submit anything on it yourself. Stopping it and replacing its access token are done at the terminal (build-loop serve --stop, --rotate).', inputSchema: strict({}, []) },
  inspect: { description: 'Read bounded project signals and return recommendations plus precise missing setup inputs.', inputSchema: strict({}, []) },
  doctor: { description: 'Check the control host, active/candidate configuration, provider installation, and authentication without exposing command output.', inputSchema: strict({}, []) },
  demo: { description: 'Create a runnable docs or Python demonstration in an empty selected project root and prepare a paused setup candidate.', inputSchema: strict({ kind: { enum: ['docs', 'python'] } }, ['kind']) },
  configure: { description: 'Persist signed machine-local builder and reviewer providers, resolved CLI paths, and safe default authentication checks for bundled Codex or Claude providers. Optional models picks the provider model per phase (for example REVIEW: opus, default: sonnet); unset phases use the CLI default. Host chat means chat-hosted execution: this chat does each node with its own sub-agents through chat_next and chat_submit, while the engine still verifies and decides. With host chat, review_host must be chosen explicitly by the person: claude or codex for a review that runs in a separate CLI process, or chat for a review by this same chat, which is then reported everywhere, including the accept decision, as not independently isolated. Without it chat_next refuses with CHAT_REVIEW_HOST_REQUIRED; never choose it for the person.', inputSchema: strict({ host: { enum: ['codex', 'claude', 'mock', 'chat'] }, provider_path: { type: 'string', minLength: 1 }, cli_path: { type: 'string', minLength: 1 }, review_host: { enum: ['codex', 'claude', 'mock', 'chat'] }, review_provider_path: { type: 'string', minLength: 1 }, review_cli_path: { type: 'string', minLength: 1 }, models: strict(Object.fromEntries(MODEL_KEYS.map((key) => [key, modelName])), []) }, ['host']) },
  prepare: { description: 'Write a complete paused candidate from explicit intent, bounded paths, a validated adapter or recommendation, and a meaningful negative control.', inputSchema: prepareSchema },
  rebind: { description: 'After the build-loop package changed (DISTRIBUTION_CHANGED), write a re-activation candidate that keeps the active adapter, workflow, run state and work items unchanged. It then needs the same human approval and disposable probes as a first activation; only the activation record is rewritten.', inputSchema: strict({ negative_control: negativeSchema }, ['negative_control']) },
  activate: { description: 'Start a durable activation job using the persisted receipt; it runs digest-bound disposable positive and negative probes and publishes active state only when all gates pass.', inputSchema: strict({}, []) },
  task: { description: 'Prepare the next bounded work item after the previous handover is completed.', inputSchema: strict({ work_kind: workKindSchema, request: { type: 'string', minLength: 1, maxLength: 20000 }, acceptance_criteria: nonEmptyStrings, out_of_scope: nonEmptyStrings, allowed_paths: { type: 'array', minItems: 1, uniqueItems: true, items: relPath }, frozen_paths: { type: 'array', uniqueItems: true, items: relPath }, work_item_id: itemIdSchema }, ['request', 'acceptance_criteria', 'out_of_scope', 'allowed_paths']) },
  start: { description: 'Start a finite detached run from PAUSED state. If this work item has an authorization record in state PAUSED, or one that does not validate, the call is refused with AUTHORIZATION_REVOKED: a person has to authorize the item again, or run it at their own terminal. An item with no authorization record at all is a manual item and is unaffected.', inputSchema: strict({ run_mode: { enum: ['step', 'bounded'] }, request_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, max_nodes: { type: 'integer', minimum: 1, maximum: 500 } }, ['request_id']) },
  run: { description: 'Start or continue a finite detached run, executing one engine-owned node per iteration. If this work item has an authorization record in state PAUSED, or one that does not validate, the call is refused with AUTHORIZATION_REVOKED: a person has to authorize the item again, or run it at their own terminal. An item with no authorization record at all is a manual item and is unaffected.', inputSchema: strict({ run_mode: { enum: ['step', 'bounded'] }, request_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, max_nodes: { type: 'integer', minimum: 1, maximum: 500 } }, ['request_id']) },
  chat_next: { description: 'Chat-hosted execution (configure host chat and an explicit review_host first; otherwise CHAT_REVIEW_HOST_REQUIRED). Starts or continues the run for exactly one node, through the same checks as run (hold, authorization record, budgets, channel), and returns {node_id, attempt_id, label, phase, brief} as soon as the node brief is ready; if a node is already waiting, returns the same attempt again. node_id is short and opaque (n- and 12 hex digits); attempt_id is new for every wait of that node. With review_host chat it also returns review_isolated false and a warning. Give ONLY brief.prompt to a fresh sub-agent, never this conversation. DEFINE, DESIGN and HANDOVER edit only the work item file, EXECUTE only the slice allowed paths, REVIEW and VALIDATE change nothing. The engine still runs the verifiers, checks every changed path and checks the review challenge. When node_id is null no brief is waiting; follow next_action.', inputSchema: strict({}, []) },
  chat_submit: { description: 'Hand the sub-agent result for the waiting chat node to the engine: one result JSON (schema_version, status DONE or BLOCKED, defect_class, blocker, notes) or, for REVIEW, one verdict JSON echoing the challenge values from the brief. Pass node_id and attempt_id exactly as chat_next returned them. It is checked against the provider result schema, taken at most once per attempt, refused for an unknown node (CHAT_NODE_UNKNOWN), an attempt that already has its result (CHAT_NODE_ALREADY_SUBMITTED) or an attempt that is no longer the one waiting (CHAT_NODE_STALE; call chat_next and use the new attempt_id). accepted is true only once the waiting node actually took the result; a result nobody took is withdrawn and answered with CHAT_NODE_STALE. Then it waits for the engine to finish the node and returns the gate result, the check summary and whether another node is waiting.', inputSchema: strict({ node_id: { type: 'string', pattern: '^n-[0-9a-f]{12}$' }, attempt_id: { type: 'string', pattern: '^[0-9a-f]{32}$' }, result: { type: 'object' } }, ['node_id', 'attempt_id', 'result']) },
  status: { description: 'Return canonical engine status plus durable detached-job progress.', inputSchema: strict({ job_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } }, []) },
  answer: { description: 'Record an actual human answer in a structured sidecar and resolve exactly one referenced blocker.', inputSchema: strict({ blocker_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, blocker_index: { type: 'integer', minimum: 1, maximum: 10000 }, answer: { type: 'string', minLength: 1, maxLength: 20000 } }, ['answer']) },
  pause: { description: 'Request that a detached worker finish its current bounded node and then pause.', inputSchema: strict({}, []) },
  cancel: { description: 'Request that a detached worker finish its current bounded node and then cancel. With no job in flight, a BLOCKED or PAUSED run is cancelled at once, so handover can acknowledge it.', inputSchema: strict({}, []) },
  resume: { description: 'Resume a PAUSED run, or a BLOCKED run after all blockers are resolved, preserving original time and retry caps. If this work item has an authorization record in state PAUSED, or one that does not validate, the call is refused with AUTHORIZATION_REVOKED: a person has to authorize the item again, or run it at their own terminal. An item with no authorization record at all is a manual item and is unaffected.', inputSchema: strict({ run_mode: { enum: ['step', 'bounded'] }, request_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }, max_nodes: { type: 'integer', minimum: 1, maximum: 500 } }, ['request_id']) },
  handover: { description: 'Acknowledge a passed HANDOVER gate or a cancellation and complete the local work item without performing delivery actions.', inputSchema: strict({ note: { type: 'string', minLength: 1, maxLength: 20000 } }, ['note']) },
  check: { description: 'Read-only one-glance answer to "where does this project stand": run status, phase, whether a handover is waiting to be looked at, the recorded review verdict, gates, open blockers, backlog and inbox counts, how human confirmations may be given in this project, and the next action. It never changes state.', inputSchema: strict({}, []) },
  tick: { description: 'One cadence step for a timer, a schedule, or a chat client: report while a job runs, advance one node of a running item, report a blocked or waiting run, or start an item a person already authorized as READY within its recorded scope, budget and expiry. It never grants approval and never starts a paused or expired item.', inputSchema: strict({ max_nodes: { type: 'integer', minimum: 1, maximum: 500 } }, []) },
  backlog_add: { description: 'Write a new work item file from the template and append it to the ordered backlog. It never starts, authorizes, or schedules anything.', inputSchema: strict({ id: itemIdSchema, title: { type: 'string', minLength: 1, maxLength: 200 }, work_kind: workKindSchema, outcome: { type: 'string', minLength: 1, maxLength: 20000 } }, ['title', 'outcome']) },
  backlog_list: { description: 'List the ordered backlog with each item authorization state, plus ready and paused counts.', inputSchema: strict({}, []) },
  backlog_remove: { description: 'Remove one item from the ordered backlog. The work item file and its authorization sidecar are kept on disk.', inputSchema: strict({ id: itemIdSchema }, ['id']) },
  accept: { description: 'Human-only. Accept a finished run whose HANDOVER gate passed: archive it under the local history directory and promote the next backlog item as a fresh paused work item. Requires the literal confirmation word ACCEPT. From a chat tool call this operation does not complete: it returns a link to a local page that shows the exact run and its handover evidence, frozen at that moment, and the person must type ACCEPT there before anything is archived or promoted. Hand the link over; never open it yourself. If the run moved on in the meantime the confirmation is refused as CONFIRMATION_STALE. A project set to tty-only in .loop/control/policy.json refuses this call with CONFIRMATION_TTY_ONLY and the command for the person to run at their own terminal.', inputSchema: strict({ confirm: { const: 'ACCEPT' }, note: { type: 'string', minLength: 1, maxLength: 20000 } }, ['confirm']) },
  authorize: { description: 'Human-only. Record that a backlog item may start when its slot comes, with an explicit path scope, round and wall-clock budget, and an expiry. Requires the literal confirmation word AUTHORIZE. From a chat tool call this operation does not complete: it returns a link to a local page that shows the exact record that would be written, defaults, budget and expiry included, and the person must type AUTHORIZE there before the item is authorized. Hand the link over; never open it yourself. A project set to tty-only in .loop/control/policy.json refuses this call with CONFIRMATION_TTY_ONLY and the command for the person to run at their own terminal. It never starts a run by itself.', inputSchema: strict({ confirm: { const: 'AUTHORIZE' }, item_id: itemIdSchema, allowed_paths: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: relPath }, max_rounds: { type: 'integer', minimum: 1, maximum: 500 }, max_wall_seconds: { type: 'integer', minimum: 60, maximum: 604800 }, expires_in_seconds: { type: 'integer', minimum: 60, maximum: 2592000 }, stop_on_first_failure: { type: 'boolean' }, note: { type: 'string', minLength: 1, maxLength: 20000 } }, ['confirm']) },
  deauthorize: { description: 'Set a work item authorization back to PAUSED and place a project-wide hold, so nothing automated may start, run, resume, tick, prepare a new task or scout in this project until a person releases the hold. Reading, cancel and handover stay available.', inputSchema: strict({ item_id: itemIdSchema }, []) },
  hold: { description: 'Stop everything in this project now. Any channel may place a hold: while it is on, start, run, resume, tick, task and scout are refused for every caller that is not a person at an interactive terminal. It changes no work item and no gate, and only a person can take it off again with release.', inputSchema: strict({ reason: { type: 'string', minLength: 1, maxLength: 4000 }, item_id: itemIdSchema }, []) },
  release: { description: 'Human-only. Take the project-wide hold off so automated entry points may work again. Requires the literal confirmation word RELEASE. From a chat tool call this operation does not complete: it returns a link to a local page that shows the exact hold that would be lifted, and the person must type RELEASE there. Hand the link over; never open it yourself. A project set to tty-only in .loop/control/policy.json refuses this call with CONFIRMATION_TTY_ONLY and the command for the person to run at their own terminal. It starts nothing.', inputSchema: strict({ confirm: { const: 'RELEASE' } }, ['confirm']) },
  scout: { description: 'Look for work that could be worth doing. The provider is named, never pathed: claude, codex or mock, and only the wrapper bundled with this distribution is executed, in a disposable copy of the project with read-only tooling, a clean environment and an isolated home directory, so nothing in the real project changes. It writes inert proposals into .loop/inbox and never touches the backlog, the state, or a run.', inputSchema: strict({ provider: { enum: ['claude', 'codex', 'mock'] }, profile: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, work_kind: workKindSchema }, []) },
  inbox_list: { description: 'List the scout proposals waiting in the inbox with their title, creation time and provider. It changes nothing.', inputSchema: strict({}, []) },
  promote: { description: 'Move one inbox proposal into the ordered backlog as a work item, keeping its outcome, constraints and evidence pointers. From a chat tool call this operation does not complete: it returns a link to a local page that names the proposal and the digest of its exact text, and the person must type PROMOTE there. Hand the link over; never open it yourself. A proposal rewritten after the person read it is refused as CONFIRMATION_STALE. A project set to tty-only in .loop/control/policy.json refuses this call with CONFIRMATION_TTY_ONLY and the command for the person to run at their own terminal. It starts and authorizes nothing.', inputSchema: strict({ proposal_id: proposalIdSchema, id: itemIdSchema, work_kind: workKindSchema }, ['proposal_id']) },
  discard: { description: 'Remove one proposal from the inbox index and move its file into .loop/inbox/discarded. Nothing else changes.', inputSchema: strict({ proposal_id: proposalIdSchema }, ['proposal_id']) },
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

export function validateAuthorization(value, label = 'authorization') {
  exactKeys(value, ['schema_version', 'item_id', 'state', 'scope', 'budget', 'expires_at', 'stop_on_first_failure', 'authorized_by', 'authorized_at', 'assurance', 'note'], ['schema_version', 'item_id', 'state', 'authorized_by', 'authorized_at'], label);
  if (value.schema_version !== 1) throw new ControlError('INVALID_INPUT', `${label}.schema_version must be 1`);
  stringValue(value.item_id, `${label}.item_id`, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ });
  if (!['PAUSED', 'READY'].includes(value.state)) throw new ControlError('INVALID_INPUT', `${label}.state must be PAUSED or READY`);
  if (!authorizationChannels.includes(value.authorized_by)) throw new ControlError('INVALID_INPUT', `${label}.authorized_by is not a recognised human channel`);
  timestampValue(value.authorized_at, `${label}.authorized_at`);
  if (value.scope !== undefined) {
    exactKeys(value.scope, ['allowed_paths'], ['allowed_paths'], `${label}.scope`);
    safeRelativeArray(value.scope.allowed_paths, `${label}.scope.allowed_paths`, 1);
  }
  if (value.budget !== undefined) {
    exactKeys(value.budget, ['max_rounds', 'max_wall_seconds'], ['max_rounds', 'max_wall_seconds'], `${label}.budget`);
    intValue(value.budget.max_rounds, `${label}.budget.max_rounds`, 1, 500);
    intValue(value.budget.max_wall_seconds, `${label}.budget.max_wall_seconds`, 60, 604800);
  }
  if (value.expires_at !== undefined) timestampValue(value.expires_at, `${label}.expires_at`);
  if (value.stop_on_first_failure !== undefined && typeof value.stop_on_first_failure !== 'boolean') throw new ControlError('INVALID_INPUT', `${label}.stop_on_first_failure must be true or false`);
  // How the decision was obtained. Both human channels are a local user action:
  // somebody with access to this machine did it, which is not proof of who.
  if (value.assurance !== undefined && value.assurance !== 'local-user-action') throw new ControlError('INVALID_INPUT', `${label}.assurance must be local-user-action`);
  if (value.note !== undefined) stringValue(value.note, `${label}.note`, { max: 20000 });
  if (value.state === 'READY') {
    const missing = ['scope', 'budget', 'expires_at', 'stop_on_first_failure'].filter((key) => value[key] === undefined);
    if (missing.length) throw new ControlError('INVALID_INPUT', `${label} in state READY is missing: ${missing.join(', ')}`, { missing_inputs: missing });
  }
  return value;
}

// The project-wide hold record. A hold that does not validate is still a hold —
// control/hold.mjs fails closed on it — but it is reported as broken so a person
// can see that it has to be written again or released.
export function validateHold(value, label = 'hold') {
  exactKeys(value, ['schema_version', 'held_at', 'held_by', 'reason', 'item_id'], ['schema_version', 'held_at', 'held_by', 'reason'], label);
  if (value.schema_version !== 1) throw new ControlError('INVALID_INPUT', `${label}.schema_version must be 1`);
  timestampValue(value.held_at, `${label}.held_at`);
  if (!authorizationChannels.includes(value.held_by)) throw new ControlError('INVALID_INPUT', `${label}.held_by is not a recognised channel`);
  stringValue(value.reason, `${label}.reason`, { max: 4000 });
  if (value.item_id !== undefined && value.item_id !== null) stringValue(value.item_id, `${label}.item_id`, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ });
  return { schema_version: 1, held_at: value.held_at, held_by: value.held_by, reason: value.reason, item_id: value.item_id ?? null };
}

export function validateOperation(operation, args) {
  if (!Object.hasOwn(operations, operation)) throw new ControlError('UNKNOWN_OPERATION', `unknown operation: ${operation}`);
  if (['prepare', 'task', 'backlog_add', 'promote', 'scout'].includes(operation)) validateKind(args.work_kind);
  const keys = Object.keys(operations[operation].inputSchema.properties);
  exactKeys(args, keys, operations[operation].inputSchema.required || [], 'args');
  if (Object.hasOwn(args, 'root')) throw new ControlError('UNKNOWN_FIELD', 'root is fixed by the transport and cannot appear in args');
  return args;
}

export { adapterSchema, authorizationChannels, authorizationSchema, holdSchema, negativeSchema, prepareSchema, transportChannels };
