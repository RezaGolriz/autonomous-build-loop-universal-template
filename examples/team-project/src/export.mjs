// Starting point for package B: support commas, quotes and newlines in CSV.
export function exportCsv(notes) {
  if (!Array.isArray(notes)) throw new TypeError('Notes must be an array');
  return ['id,title', ...notes.map(note => `${note.id},${note.title}`)].join('\n') + '\n';
}
