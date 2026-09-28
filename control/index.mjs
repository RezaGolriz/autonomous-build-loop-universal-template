import { loopOptions, resolveRunArgs } from './loop-options.mjs';
import { openDashboard } from './dashboard.mjs';
import { ControlError, confirmationPolicy, publicError, resolveRoot } from './common.mjs';
import { autostartControlPage, controlPageAutostart, runningControlPage, runningControlPageLink, serveControlPage } from './control-page.mjs';
import { requestApproval as approvalRequest } from './approval.mjs';
import { createDemo, inspectProject, prepareProject, prepareRebind } from './setup.mjs';
import { answerBlocker, completeHandover, configureHost, createTask, doctor, launchActivation, launchJob, setIntent, status } from './jobs.mjs';
import { backlogAdd, backlogList, backlogRemove, deauthorize } from './backlog.mjs';
import { check } from './check.mjs';
import { tick } from './tick.mjs';
import { chatNext, chatSubmit } from './chat.mjs';
import { discard, inboxList, scout } from './scout.mjs';
import { humanDecision } from './human-ops.mjs';
import { HELD_OPERATIONS, assertNotHeld, placeHold } from './hold.mjs';
import { operations, transportChannels, validateOperation } from './schemas.mjs';
import { readStore } from './package-store.mjs';
import { teamConfigure, teamStatus } from './team.mjs';
import { verifyMemberReadiness } from '../runtimes/api-runtime.mjs';
import { packageAdd, packageList, supervisorStart, supervisorStatus, supervisorPause, supervisorCancel, supervisorResume, supervisorRecover } from './supervisor.mjs';

export { operations };

// Which human boundary a decision came through. The command line states an
// interactive typed confirmation or an explicit input file; anything else is a
// model-facing transport and is recorded as such. Only `interactive-tty` is a
// person by itself; the others have to ask for a local confirmation.
function humanChannel(context) {
  const channel = context?.channel ?? 'mcp-user';
  if (!transportChannels.includes(channel)) throw new ControlError('INVALID_APPROVAL_CHANNEL', 'unrecognised decision channel');
  return channel;
}

export async function requestApproval(root, args = {}) {
  try { return await approvalRequest(await resolveRoot(root), args); }
  catch (error) { return publicError(error); }
}

// Operations that bring the control page up when the policy asks for autostart
// (controlPageAutostart), done here so no operation has to know about it. The
// human decisions do it before they run, so the link they hand out names the
// running page rather than a one-request page; the others after they succeed.
// tick does it itself, first thing, even on a held project.
const AUTOSTART_BEFORE = Object.freeze(['accept', 'authorize', 'promote', 'release']);
const AUTOSTART_AFTER = Object.freeze(['start', 'run', 'resume', 'hold', 'backlog_add', 'scout', 'chat_next', 'chat_submit']);

export async function dispatch(root, operation, args = {}, context = {}) {
  const result = await operate(root, operation, args, context);
  if (AUTOSTART_AFTER.includes(operation) && result?.ok !== false) {
    const resolved = await resolveRoot(root).catch(() => null);
    if (resolved) await autostartControlPage(resolved, { reason: operation });
  }
  return result;
}

async function operate(root, operation, args, context) {
  try {
    root = await resolveRoot(root); validateOperation(operation, args);
    if (operation === 'demo' && !['docs', 'python'].includes(args.kind)) throw new ControlError('INVALID_INPUT', 'kind must be docs or python');
    if (operation === 'status' && args.job_id !== undefined && (typeof args.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.job_id))) throw new ControlError('INVALID_INPUT', 'job_id is invalid');
    if (operation === 'handover' && (typeof args.note !== 'string' || !args.note.trim())) throw new ControlError('INVALID_INPUT', 'note is required');
    // A project-wide hold stops every automated entry point, whatever the work
    // item is called. Reading stays available, and so do cancel and handover:
    // they only stop work or write down what happened. See control/hold.mjs.
    // tick checks the hold itself, after it has brought the control page up.
    if (HELD_OPERATIONS.includes(operation) && operation !== 'tick') await assertNotHeld(root, humanChannel(context), operation);
    if (AUTOSTART_BEFORE.includes(operation)) await autostartControlPage(root, { reason: operation });
    switch (operation) {
      case 'team_configure': return await teamConfigure(root, args);
      case 'team_status': return await teamStatus(root);
      case 'team_authorize': return await humanDecision(root, operation, args, humanChannel(context));
      case 'team_verify': return await verifyMemberReadiness(root, args.member_id);
      case 'package_add': return await packageAdd(root, args);
      case 'package_list': return await packageList(root);
      case 'package_control': {
        const allowed = ['inspect', 'doctor', 'demo', 'configure', 'prepare', 'rebind', 'request_approval', 'activate', 'authorize', 'deauthorize', 'status', 'check', 'chat_next', 'chat_submit', 'answer', 'pause', 'cancel', 'handover', 'accept', 'team_configure', 'team_status', 'team_authorize', 'team_verify'];
        if (!allowed.includes(args.operation)) throw new ControlError('PACKAGE_OPERATION_NOT_ALLOWED', 'Use a registered package setup, status or explicit chat operation.');
        const store = await readStore(root);
        const pkg = store.packages.find(x => x.package_id === args.package_id);
        if (!pkg) throw new ControlError('PACKAGE_NOT_FOUND', 'Register this package before addressing it.');
        if (['activate', 'chat_next', 'chat_submit'].includes(args.operation)) await assertNotHeld(root, 'mcp-user', 'package_control');
        if (args.operation === 'request_approval') {
          if (Object.keys(args.input ?? {}).some(x => !['expires_minutes'].includes(x))) throw new ControlError('UNKNOWN_FIELD', 'Invalid package approval input');
          return await approvalRequest(pkg.root, args.input ?? {}, { dashboardRoot: root });
        }
        const result = await dispatch(pkg.root, args.operation, args.input ?? {}, context);
        if (result.pending_confirmation) {
          const pageLink = await runningControlPageLink(root).catch(() => null);
          if (pageLink) return { ...result, package_id: pkg.package_id, confirmation_url: pageLink, control_page: true };
        }
        return { package_id: pkg.package_id, ...result };
      }
      case 'supervisor_start': return await supervisorStart(root, args, humanChannel(context));
      case 'supervisor_status': return await supervisorStatus(root, args);
      case 'supervisor_pause': return await supervisorPause(root, args);
      case 'supervisor_cancel': return await supervisorCancel(root, args);
      case 'supervisor_resume': return await supervisorResume(root, args, humanChannel(context));
      case 'supervisor_recover': return await supervisorRecover(root, args);
      case 'options': return loopOptions();
      case 'dashboard': return await dashboard(root);
      case 'serve': return await serveControlPage(root, { reason: 'serve' });
      case 'inspect': return await inspectProject(root);
      case 'doctor': return await doctor(root);
      case 'demo': return await createDemo(root, args.kind);
      case 'configure': return await configureHost(root, args);
      case 'prepare': return await prepareProject(root, args);
      case 'rebind': return await prepareRebind(root, args);
      case 'activate': return await launchActivation(root);
      case 'task': return await createTask(root, args, humanChannel(context));
      // Execution carries the same human boundary as a decision: the channel
      // decides whether an item whose authorization is PAUSED may be started at
      // all. See assertUsableAuthorization in control/jobs.mjs.
      case 'start': return await launchJob(root, 'start', checkedJobArgs(args), humanChannel(context));
      case 'run': return await launchJob(root, 'run', checkedJobArgs(args), humanChannel(context));
      case 'resume': return await launchJob(root, 'resume', checkedJobArgs(args), humanChannel(context));
      // Chat-hosted execution: chat_next launches through launchJob exactly as
      // run does, with the same channel, so it is refused wherever run is.
      case 'chat_next': return await chatNext(root, args, humanChannel(context));
      case 'chat_submit': return await chatSubmit(root, args, humanChannel(context));
      case 'status': return await status(root, args);
      case 'answer': return await answerBlocker(root, args);
      case 'pause': return await setIntent(root, 'PAUSED');
      case 'cancel': return await setIntent(root, 'CANCELLED');
      case 'handover': return await completeHandover(root, args);
      case 'check': return await check(root);
      case 'tick': return await tick(root, args, humanChannel(context));
      case 'backlog_add': return await backlogAdd(root, args);
      case 'backlog_list': return await backlogList(root);
      case 'backlog_remove': return await backlogRemove(root, args);
      case 'accept': return await humanDecision(root, 'accept', args, humanChannel(context));
      case 'authorize': return await humanDecision(root, 'authorize', args, humanChannel(context));
      case 'deauthorize': return await deauthorize(root, args, humanChannel(context));
      case 'scout': return await scout(root, args, humanChannel(context));
      case 'inbox_list': return await inboxList(root);
      case 'promote': return await humanDecision(root, 'promote', args, humanChannel(context));
      case 'discard': return await discard(root, args, humanChannel(context));
      // Stopping is always safe, so any channel may place a hold. Taking one off
      // is a human decision and goes through the same confirmation as accept.
      case 'hold': return await placeHold(root, args, humanChannel(context));
      case 'release': return await humanDecision(root, 'release', args, humanChannel(context));
      default: throw new Error(`unreachable operation ${operation}`);
    }
  } catch (error) { return publicError(error); }
}

// The dashboard is the control page when the project asks for one (policy
// confirmation_page or control_page_autostart) or one is already running; otherwise the short-lived
// read-only page, exactly as before.
async function dashboard(root) {
  const policy = await confirmationPolicy(root).catch(() => null);
  if (controlPageAutostart(policy) || (policy && !policy.error && policy.confirmation_page) || await runningControlPage(root).catch(() => null)) {
    return serveControlPage(root, { reason: 'dashboard' });
  }
  return openDashboard(root);
}

function checkedJobArgs(args) {
  args = resolveRunArgs(args);
  if (!Number.isInteger(args.max_nodes) || args.max_nodes < 1 || args.max_nodes > 500) throw new ControlError('INVALID_INPUT', 'max_nodes must be an integer from 1 to 500');
  if (typeof args.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.request_id)) throw new ControlError('INVALID_INPUT', 'request_id is invalid');
  return args;
}
