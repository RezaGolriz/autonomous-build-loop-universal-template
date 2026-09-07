import { ControlError, publicError, resolveRoot } from './common.mjs';
import { requestApproval as approvalRequest } from './approval.mjs';
import { createDemo, inspectProject, prepareProject } from './setup.mjs';
import { answerBlocker, completeHandover, configureHost, createTask, doctor, launchActivation, launchJob, setIntent, status } from './jobs.mjs';
import { operations, validateOperation } from './schemas.mjs';

export { operations };

export async function requestApproval(root, args = {}) {
  try { return await approvalRequest(await resolveRoot(root), args); }
  catch (error) { return publicError(error); }
}

export async function dispatch(root, operation, args = {}) {
  try {
    root = await resolveRoot(root); validateOperation(operation, args);
    if (operation === 'demo' && !['docs', 'python'].includes(args.kind)) throw new ControlError('INVALID_INPUT', 'kind must be docs or python');
    if (operation === 'status' && args.job_id !== undefined && (typeof args.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.job_id))) throw new ControlError('INVALID_INPUT', 'job_id is invalid');
    if (operation === 'handover' && (typeof args.note !== 'string' || !args.note.trim())) throw new ControlError('INVALID_INPUT', 'note is required');
    switch (operation) {
      case 'inspect': return await inspectProject(root);
      case 'doctor': return await doctor(root);
      case 'demo': return await createDemo(root, args.kind);
      case 'configure': return await configureHost(root, args);
      case 'prepare': return await prepareProject(root, args);
      case 'activate': return await launchActivation(root);
      case 'task': return await createTask(root, args);
      case 'start': return await launchJob(root, 'start', checkedJobArgs(args));
      case 'run': return await launchJob(root, 'run', checkedJobArgs(args));
      case 'resume': return await launchJob(root, 'resume', checkedJobArgs(args));
      case 'status': return await status(root, args);
      case 'answer': return await answerBlocker(root, args);
      case 'pause': return await setIntent(root, 'PAUSED');
      case 'cancel': return await setIntent(root, 'CANCELLED');
      case 'handover': return await completeHandover(root, args);
      default: throw new Error(`unreachable operation ${operation}`);
    }
  } catch (error) { return publicError(error); }
}

function checkedJobArgs(args) {
  if (!Number.isInteger(args.max_nodes) || args.max_nodes < 1 || args.max_nodes > 500) throw new ControlError('INVALID_INPUT', 'max_nodes must be an integer from 1 to 500');
  if (typeof args.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.request_id)) throw new ControlError('INVALID_INPUT', 'request_id is invalid');
  return args;
}
