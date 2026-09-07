#!/usr/bin/env node
let input = '';
for await (const chunk of process.stdin) input += chunk;
const brief = JSON.parse(input);
if (brief.phase === 'DESIGN' || brief.phase === 'HANDOVER') {
  const fs = await import('node:fs/promises'); const path = await import('node:path');
  const file = path.join(process.env.LOOP_ROOT, '.loop', 'work-items', `${brief.work_item_id}.md`); let text = await fs.readFile(file, 'utf8');
  const heading = brief.phase === 'DESIGN' ? '## Design' : '## Handover'; const content = brief.phase === 'DESIGN' ? '- Keep the demonstration artifact inside its declared path and prove it with the configured deterministic verifier.\n' : '- The local demonstration completed with runner evidence. No delivery action is authorized.\n';
  text = text.replace(`${heading}\n`, `${heading}\n\n${content}`); await fs.writeFile(file, text);
}
if (brief.phase === 'REVIEW') {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, verdict_id: `verdict-${brief.run_id}`, run_id: brief.run_id, work_item_id: brief.work_item_id, phase: 'REVIEW', gate_id: 'REVIEW', nonce: brief.nonce, result: 'PASS', reviewer: 'built-in-demo-provider', independent: true, revision: brief.revision, captured_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), evidence_refs: brief.evidence_refs, findings: [] })}\n`);
} else {
  process.stdout.write('{"schema_version":1,"status":"DONE","defect_class":null,"blocker":null,"notes":"built-in demonstration provider"}\n');
}
