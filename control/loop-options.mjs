import { ControlError } from './common.mjs';

export const workKinds = Object.freeze({
  feature: { label: 'Feature', guidance: 'Define the new behavior and demonstrate acceptance and regression coverage.' },
  defect: { label: 'Bug fix', guidance: 'Record a reproducible failure, fix its cause, and prove the regression is covered.' },
  maintenance: { label: 'Refactoring / maintenance', guidance: 'State the behavior that must remain unchanged and verify compatibility.' },
  documentation: { label: 'Documentation', guidance: 'Identify the reader and verify examples, links, and documented behavior.' },
  research: { label: 'Research', guidance: 'State the question, compare evidence, and deliver a reviewable report with limitations.' },
  migration: { label: 'Migration preparation', guidance: 'Plan compatibility, rollback, and disposable rehearsal. Live migration requires separate authority.' },
});
export function loopOptions() {
  return { ok: true, work_kinds: workKinds, run_modes: {
    step: { max_nodes: 1, description: 'Execute at most one node, then return control.' },
    bounded: { max_nodes: 12, description: 'Continue for at most 12 nodes, stopping earlier at gates, blockers or handover.' },
  }, default_work_kind: 'feature', phases: ['DEFINE', 'DESIGN', 'EXECUTE', 'REVIEW', 'VALIDATE', 'HANDOVER'], independent_review_required: true };
}
export function validateKind(kind) {
  if (kind !== undefined && !Object.hasOwn(workKinds, kind)) throw new ControlError('INVALID_INPUT', 'work_kind must be feature, defect, maintenance, documentation, research or migration');
  return kind ?? 'feature';
}
export function resolveRunArgs(args) {
  if (args.run_mode !== undefined && !['step', 'bounded'].includes(args.run_mode)) throw new ControlError('INVALID_INPUT', 'run_mode must be step or bounded');
  if (args.run_mode === 'step' && args.max_nodes !== undefined && args.max_nodes !== 1) throw new ControlError('INVALID_INPUT', 'step mode requires max_nodes=1');
  const { run_mode, ...rest } = args;
  return { ...rest, max_nodes: args.max_nodes ?? (run_mode === 'step' ? 1 : run_mode === 'bounded' ? 12 : undefined) };
}
