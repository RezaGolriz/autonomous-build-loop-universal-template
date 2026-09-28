import test from 'node:test';
import assert from 'node:assert/strict';
import { exportCsv } from '../src/export.mjs';
test('simple notes produce a header and rows', () => {
  assert.equal(exportCsv([{ id: 1, title: 'First note' }]), 'id,title\n1,First note\n');
});
