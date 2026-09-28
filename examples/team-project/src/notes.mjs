// Starting point for package A: improve title validation without changing IDs.
export function addNote(notes, title) {
  if (!Array.isArray(notes) || typeof title !== 'string') throw new TypeError('Invalid note input');
  const id = notes.reduce((largest, note) => Math.max(largest, note.id), 0) + 1;
  return [...notes, { id, title }];
}
