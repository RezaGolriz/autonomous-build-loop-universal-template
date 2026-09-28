import test from 'node:test';
import assert from 'node:assert/strict';
import { addNote } from '../src/notes.mjs';
test('adding a note preserves the input and assigns the next ID', () => {
  const notes = [{ id: 2, title: 'First note' }];
  assert.deepEqual(addNote(notes, 'Second note'), [{ id: 2, title: 'First note' }, { id: 3, title: 'Second note' }]);
  assert.deepEqual(notes, [{ id: 2, title: 'First note' }]);
});
test('invalid input types are rejected', () => {
  assert.throws(() => addNote([], null), /Invalid note input/);
});
