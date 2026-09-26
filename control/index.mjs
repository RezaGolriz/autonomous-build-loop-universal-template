import { loopOptions, resolveRunArgs } from './loop-options.mjs';
import { openDashboard } from './dashboard.mjs';
import { ControlError, confirmationPolicy, publicError, resolveRoot } from './common.mjs';
import { runningControlPage, serveControlPage } from './control-page.mjs';
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

export async function dispatch(root, operation, args = {}, context = {}) {
  try {
    root = await resolveRoot(root); validateOperation(operation, args);
    if (operation === 'demo' && !['docs', 'python'].includes(args.kind)) throw new ControlError('INVALID_INPUT', 'kind must be docs or python');
    if (operation === 'status' && args.job_id !== undefined && (typeof args.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.job_id))) throw new ControlError('INVALID_INPUT', 'job_id is invalid');
    if (operation === 'handover' && (typeof args.note !== 'string' || !args.note.trim())) throw new ControlError('INVALID_INPUT', 'note is required');
    // A project-wide hold stops every automated entry point, whatever the work
    // item is called. Reading stays available, and so do cancel and handover:
    // they only stop work or write down what happened. See control/hold.mjs.
    if (HELD_OPERATIONS.includes(operation)) await assertNotHeld(root, humanChannel(context), operation);
    switch (operation) {
      case 'options': return loopOptions();
      case 'dashboard': return await dashboard(root);
      case 'serve': return await serveControlPage(root);
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
// confirmation_page) or one is already running; otherwise the short-lived
// read-only page, exactly as before.
async function dashboard(root) {
  const policy = await confirmationPolicy(root).catch(() => null);
  if ((policy && !policy.error && policy.confirmation_page) || await runningControlPage(root).catch(() => null)) {
    return serveControlPage(root);
  }
  return openDashboard(root);
}

function checkedJobArgs(args) {
  args = resolveRunArgs(args);
  if (!Number.isInteger(args.max_nodes) || args.max_nodes < 1 || args.max_nodes > 500) throw new ControlError('INVALID_INPUT', 'max_nodes must be an integer from 1 to 500');
  if (typeof args.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.request_id)) throw new ControlError('INVALID_INPUT', 'request_id is invalid');
  return args;
}
