// Deliberately failing validation probe, not a product test to make green.
import assert from 'node:assert/strict';
import { addNote } from '../src/notes.mjs';
try {
  assert.deepEqual(addNote([], 'First note'), []);
  process.exitCode = 0;
} catch (error) {
  if (error instanceof assert.AssertionError) {
    process.stderr.write('NEGATIVE_CONTROL: added note differs from the deliberately wrong expectation\n');
    process.exitCode = 42;
  } else throw error;
}
