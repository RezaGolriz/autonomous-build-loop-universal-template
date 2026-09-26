// The decisions only a person may make: accept a finished run, authorize an
// item to run when its slot comes, promote a scout proposal into the backlog,
// and release a project-wide hold. This module is the single place that decides
// how such a call is allowed to complete.
//
// Placing a hold needs no confirmation at all — stopping is always safe, and any
// channel may do it. Taking one off is the opposite direction, so `release` is
// here with the others.
//
// A typed word at an interactive terminal completes the decision directly, and
// the record keeps `interactive-tty` as the channel. Every other transport —
// a JSON input file on the command line, or an MCP tool call — gets a pending
// request and a link to a local confirmation page instead. The request carries
// the fully resolved decision, frozen: the operation, the item, every argument
// including its defaults, and a fingerprint of what is being decided about. The
// page displays exactly that. When the person types the decision word there and
// presses the button, a signed receipt is written and the operation runs with
// the channel `local-http-user`.
//
// Assurance. Both channels record `local-user-action`: somebody with access to
// this machine did it. That is an honest description and not a proof of who.
// A project that wants the terminal and nothing else sets `human_confirmation`
// to "tty-only" in .loop/control/policy.json; the confirmation page is then
// refused and every such call is answered with CONFIRMATION_TTY_ONLY.
import path from 'node:path';
import { ControlError, confirmationPolicy, exists, readJson } from './common.mjs';
import {
  accept, acceptanceSubject, authorizationRecord, authorizationSubject, authorize, authorizeFrozen,
  currentOrFirstBacklogItem, workItemFile,
} from './backlog.mjs';
import { promote, proposalFingerprint } from './scout.mjs';
import { holdSubject, readHold, releaseHold } from './hold.mjs';
import { REVIEW_NOT_ISOLATED, recordedReview } from './chat.mjs';
import { LOCAL_USER_ACTION, discardPendingConfirmations, humanOperations, requestConfirmation, settleConfirmations } from './confirm.mjs';

const TTY_ONLY_DISCARDED = 'this project now accepts human decisions only as a word typed at an interactive terminal; the pending page request was thrown away';

// Runners for a confirmed request. Each receives the frozen request and checks
// it against the live project inside the lock in which it does the work.
const runners = {
  accept: (root, request) => accept(root, { ...request.decision.args, confirm: humanOperations.accept }, 'local-http-user', request.decision.subject),
  authorize: (root, request) => authorizeFrozen(root, request.decision.record, request.decision.subject),
  promote: (root, request) => promote(root, request.decision.args, 'local-http-user', request.decision.subject),
  release: (root, request) => releaseHold(root, { confirm: 'RELEASE' }, 'local-http-user', request.decision.subject),
};

// The policy decides first. A project that has been set to tty-only since a page
// request was written must not have that request carried out: it is discarded,
// not settled, whichever caller (a decision, a tick, or the page itself) got here.
export async function settleHumanDecisions(root, policy = null) {
  const effective = policy ?? await confirmationPolicy(root);
  if (effective.human_confirmation === 'tty-only') return discardPendingConfirmations(root, TTY_ONLY_DISCARDED);
  const settled = await settleConfirmations(root, runners);
  for (const entry of settled) if (entry.result?.ok) entry.result.assurance = LOCAL_USER_ACTION;
  return settled;
}

// Which item the person is deciding about. It is resolved before the request is
// written, so the confirmation is bound to one exact item even when the caller
// left it implicit.
async function decisionItem(root, operation, args) {
  const loop = path.join(root, '.loop');
  if (operation === 'promote') return args.proposal_id ?? null;
  if (operation === 'release') return (await readHold(root).catch(() => null))?.item_id ?? null;
  if (operation === 'authorize') return args.item_id ?? await currentOrFirstBacklogItem(loop);
  const state = await readJson(path.join(loop, 'state.json'), 'state');
  return state.work_item_id ?? null;
}

const line = (label, value) => ({ label, value: String(Array.isArray(value) ? value.join(', ') : value).slice(0, 2000) });

// Freeze the decision. Everything that will happen is resolved here — the
// defaults, the expiry, the budget, and the fingerprint of the exact run or
// proposal — so that the page shows the decision itself and not a description
// of it, and so that settlement can prove nothing moved in between.
async function freezeDecision(root, operation, itemId, args) {
  const loop = path.join(root, '.loop');
  if (operation === 'authorize') {
    if (!itemId) throw new ControlError('MISSING_INPUT', 'item_id is required when no current work item exists', { missing_inputs: ['item_id'] });
    if (!await exists(workItemFile(loop, itemId))) throw new ControlError('WORK_ITEM_NOT_FOUND', `no work item file exists for ${itemId}`);
    const record = await authorizationRecord(loop, { ...args, item_id: itemId }, 'local-http-user');
    const subject = await authorizationSubject(loop, record.item_id);
    return {
      decision: { kind: 'authorize', record, subject },
      summary: [
        line('Operation', 'authorize (let this item run when its slot comes)'),
        line('Item', record.item_id),
        line('Work item file digest (sha256)', subject.work_item_sha256),
        line('Existing authorization digest (sha256)', subject.authorization_sha256 ?? 'none on file'),
        line('Allowed paths', record.scope.allowed_paths),
        line('Budget', `${record.budget.max_rounds} rounds, ${record.budget.max_wall_seconds} seconds of wall clock`),
        line('Expires at', record.expires_at),
        line('Stop on first failure', String(record.stop_on_first_failure)),
        ...(record.note ? [line('Note', record.note)] : []),
        line('Assurance', `${record.assurance} — a person acting on this machine; it is not proof of who`),
      ],
    };
  }
  if (operation === 'release') {
    const hold = await readHold(root);
    if (!hold) throw new ControlError('NOT_ON_HOLD', 'this project is not on hold; there is nothing to release');
    const subject = await holdSubject(root);
    return {
      decision: { kind: 'release', subject },
      summary: [
        line('Operation', 'release (take the project-wide hold off, so automated entry points may work again)'),
        line('Held at', hold.held_at ?? 'not recorded'),
        line('Held by', hold.held_by ?? 'not recorded'),
        line('Reason', hold.reason ?? 'not recorded'),
        line('Work item the hold was placed for', hold.item_id ?? 'none recorded'),
        line('Hold record digest (sha256)', subject.hold_sha256),
        line('Assurance', `${LOCAL_USER_ACTION} — a person acting on this machine; it is not proof of who`),
      ],
    };
  }
  if (operation === 'accept') {
    const subject = await acceptanceSubject(loop);
    if (itemId && subject.work_item_id !== itemId) throw new ControlError('CONFIRMATION_STALE', 'the run changed while the acceptance was being prepared');
    const { confirm, ...rest } = args;
    // A review done by the chat that built the change is said plainly in the
    // frozen decision, so the person accepts knowing it.
    const review = await recordedReview(root, subject.work_item_id).catch(() => null);
    return {
      decision: { kind: 'accept', subject, args: rest },
      summary: [
        line('Operation', 'accept (archive this finished run and promote the next backlog item)'),
        line('Work item', subject.work_item_id),
        line('Round', subject.round),
        line('HANDOVER evidence', subject.handover_evidence_ids.length ? subject.handover_evidence_ids : 'none recorded'),
        ...(review && !review.review_isolated ? [line('Review independence', `${REVIEW_NOT_ISOLATED}. The REVIEW node was done by the chat that built the change, not by a separate reviewer.`)] : []),
        ...(rest.note ? [line('Note', rest.note)] : []),
        line('Assurance', `${LOCAL_USER_ACTION} — a person acting on this machine; it is not proof of who`),
      ],
    };
  }
  const subject = await proposalFingerprint(loop, args.proposal_id);
  const { confirm, ...rest } = args;
  return {
    decision: { kind: 'promote', subject, args: rest },
    summary: [
      line('Operation', 'promote (move this proposal into the backlog)'),
      line('Proposal', subject.proposal_id),
      line('Title', subject.title ?? 'not recorded'),
      line('Proposal file digest (sha256)', subject.proposal_sha256),
      ...(rest.id ? [line('Backlog item id', rest.id)] : []),
      ...(rest.work_kind ? [line('Work kind', rest.work_kind)] : []),
      line('Assurance', `${LOCAL_USER_ACTION} — a person acting on this machine; it is not proof of who`),
    ],
  };
}

// The command a person can run at their own terminal to make exactly the
// decision that was asked for here. Every argument is carried over — the item or
// proposal, the scope, the budget, the expiry — through --input, so the person
// does not have to reconstruct them and nothing silently falls back to the
// current item. Single quotes make the shell hand the JSON over verbatim.
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

async function ttyFallbackCommand(root, operation, args) {
  const { confirm, ...rest } = args ?? {};
  const payload = { ...rest };
  if (operation === 'authorize' && payload.item_id === undefined) {
    const resolved = await decisionItem(root, operation, args).catch(() => null);
    if (resolved) payload.item_id = resolved;
  }
  const base = `build-loop ${operation} --root ${shellQuote(root)}`;
  return Object.keys(payload).length ? `${base} --input ${shellQuote(JSON.stringify(payload))}` : base;
}

export async function humanDecision(root, operation, args, channel) {
  if (!Object.hasOwn(humanOperations, operation)) throw new ControlError('INVALID_INPUT', `${operation} is not a human decision`);
  // The policy is read before anything is settled: under tty-only a request that
  // is still pending from an earlier policy is thrown away rather than carried
  // out, so a page link can never outlive the rule that allowed it. A policy
  // nobody can read is the strictest mode there is, so the local page is closed
  // while it is broken and a person can still decide at their own terminal.
  const policy = await confirmationPolicy(root);
  // Anything a person already confirmed in the browser is carried out first, so
  // a repeated call reports the finished decision instead of asking again.
  await settleHumanDecisions(root, policy).catch(() => []);
  if (channel === 'interactive-tty') {
    if (operation === 'accept') return accept(root, args, channel);
    if (operation === 'authorize') return authorize(root, args, channel);
    if (operation === 'release') return releaseHold(root, args, channel);
    return promote(root, args, channel);
  }
  if (policy.human_confirmation === 'tty-only') {
    const command = await ttyFallbackCommand(root, operation, args);
    if (policy.error) {
      throw new ControlError(policy.error.code, `${policy.error.message}. Until it is repaired this project accepts ${operation} only as a word typed at an interactive terminal. Ask the person to run: ${command} — the terminal still asks them to type ${humanOperations[operation]}.`, {
        human_confirmation: 'tty-only',
        command,
        policy_file: '.loop/control/policy.json',
        policy_error: policy.error,
      });
    }
    throw new ControlError('CONFIRMATION_TTY_ONLY', `this project accepts ${operation} only as a word typed at an interactive terminal. Ask the person to run: ${command} — the terminal still asks them to type ${humanOperations[operation]}.`, {
      human_confirmation: 'tty-only',
      command,
      policy_file: '.loop/control/policy.json',
    });
  }
  const itemId = await decisionItem(root, operation, args);
  const { confirm } = args;
  if (operation !== 'promote' && confirm !== humanOperations[operation]) {
    throw new ControlError('CONFIRMATION_REQUIRED', `this is a human decision; repeat it with confirm set to ${humanOperations[operation]}`);
  }
  const frozen = await freezeDecision(root, operation, itemId, args);
  return requestConfirmation(root, operation, itemId, args, frozen.decision, frozen.summary);
}
