// Contract 4.12: a section filter also names its canonical section family.
// Journal contains Stream, dated entries and article headings; the family
// must match exactly, rather than accepting a title containing 'journal'.
export function onlyJournalPassages(passages) {
  return (
    passages.length > 0 &&
    passages.every(
      (p) =>
        p.source_kind === 'weekly_thing' &&
        String(p.section_family || p.section || '')
          .trim()
          .toLowerCase() === 'journal'
    )
  );
}
