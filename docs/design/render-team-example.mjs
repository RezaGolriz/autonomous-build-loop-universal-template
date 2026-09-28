// Rebuild the reading example from the product's actual component.
// Example observations only: this script never starts or approves work.
import { writeFile } from 'node:fs/promises';
import { renderTeamDashboard } from '../../control/team-dashboard.mjs';
const phases = ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'];
const gates = passed => Object.fromEntries(phases.map((phase, i) => [phase, { status: i < passed ? 'PASSED' : 'PENDING', evidence_ids: i < passed ? [`example-${phase.toLowerCase()}`] : [] }]));
const common = { accepted: false, integrated: false, execution_kind: 'managed_api', attempt: 1, max_attempts: 3,
  elapsed_seconds: 120, hard_seconds: 900, checkpoint_at: 'Example checkpoint', heartbeat_at: 'Example heartbeat',
  expires_at: 'Example approved expiry', reported_model: 'example-builder-model', model_source: 'Illustrative response record from DESIGN',
  member_id: 'example-builder', session_id: 'example-api-node-session', job_id: 'example-child-job', revision: 'example-revision' };
const view = { mode: 'parallel', status: 'EXAMPLE ONLY', max_active_packages: 2, max_active_agents: 2,
  progress_unit: 'gates', members: ['builder', 'reviewer'].map(role => ({ id: `example-${role}`, role,
    provider: 'Example provider', requested_model: `example-${role}-model`, execution_kind: 'managed_api',
    readiness: 'Illustrative only', capability_note: 'This reading example proves no live provider access.' })),
  packages: [
    { ...common, id: 'getting-started', title: 'Improve the getting-started guide', workspace: '/example/getting-started',
      status: 'RUNNING', phase: 'EXECUTE', gates: gates(2), progress: { passed: 2, total: 6 },
      evidence_refs: ['example-define', 'example-design'], next_action: 'Complete the scoped guide edit.' },
    { ...common, id: 'troubleshooting', title: 'Add troubleshooting examples', workspace: '/example/troubleshooting',
      status: 'BLOCKED', phase: 'VALIDATE', gates: gates(4), progress: { passed: 4, total: 6 },
      member_id: 'example-reviewer', reported_model: 'example-reviewer-model', model_source: 'Illustrative response record from REVIEW',
      evidence_refs: ['example-define', 'example-design', 'example-execute', 'example-review'],
      blocker: 'A documentation check failed. Read its evidence and correct the broken link.', next_action: 'Correct the defect before another validation step.' },
    { id: 'release-notes', title: 'Prepare release notes', workspace: '/example/release-notes', status: 'NEEDS_SETUP',
      progress: null, accepted: false, integrated: false, next_action: 'Prepare and approve this package before starting.' }
  ] };
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build Loop team dashboard example</title><style>body{margin:0;padding:24px;background:#f3f5f9;font:16px/1.5 system-ui;color:#172335}body>p{max-width:1100px;margin:0 auto 20px}</style></head><body><p><b>Interactive reading example.</b> Uses the actual dashboard component with illustrative data. Models, sessions, timestamps and evidence are examples. It does not connect to agents, configure a project or start work.</p>${renderTeamDashboard(view, 'example0123456789abcdef')}</body></html>`;
await writeFile(new URL('./team-dashboard.html', import.meta.url), html);
