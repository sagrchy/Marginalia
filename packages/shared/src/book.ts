/** A contents entry: title, first PDF page (0-based) and depth (0 = top). */
export type ContentsEntry = { title: string; pageIndex: number; level: number };
/** A contents entry with its last page (inclusive) and position in the list. */
export type ContentsRange = ContentsEntry & { end: number; index: number };

/** Each entry runs until the next entry at the same or a higher level starts. */
export function withRanges(chapters: ContentsEntry[], pageCount: number): ContentsRange[] {
  return chapters.map((c, i) => {
    let end = pageCount - 1;
    for (let j = i + 1; j < chapters.length; j++) {
      if (chapters[j].level <= c.level) {
        end = Math.max(c.pageIndex, chapters[j].pageIndex - 1);
        break;
      }
    }
    return { ...c, end, index: i };
  });
}

/**
 * Which contents level is "the chapter" for studying: the shallowest level where most of the book's
 * pages sit in study-sized entries (up to 80 pages). Books with parts put chapters at level 1; others at 0.
 * Weighting by pages keeps short front matter (Preface, Acknowledgments) from deciding.
 */
export function chapterLevel(chapters: ContentsEntry[], pageCount: number): number {
  const ranges = withRanges(chapters, pageCount);
  const levels = [...new Set(chapters.map((c) => c.level))].sort((a, b) => a - b);
  for (const level of levels) {
    const at = ranges.filter((r) => r.level === level);
    if (at.length < 2) continue;
    const covered = at.reduce((n, r) => n + (r.end - r.pageIndex + 1), 0);
    const studySized = at.filter((r) => r.end - r.pageIndex + 1 <= 80).reduce((n, r) => n + (r.end - r.pageIndex + 1), 0);
    if (covered > 0 && studySized / covered >= 0.6) return level;
  }
  return levels[0] ?? 0;
}

/** The chapter (study unit) containing a page, or null when the book has no contents for it. */
export function chapterAt(chapters: ContentsEntry[], pageCount: number, pageIndex: number): ContentsRange | null {
  const level = chapterLevel(chapters, pageCount);
  const ranges = withRanges(chapters, pageCount);
  const exact = [...ranges].reverse().find((r) => r.level === level && r.pageIndex <= pageIndex && r.end >= pageIndex);
  if (exact) return exact;
  // Front matter or a part opening: the deepest entry that contains the page.
  return [...ranges].reverse().find((r) => r.level <= level && r.pageIndex <= pageIndex && r.end >= pageIndex) ?? null;
}

/** The sections (one level below the chapter) inside a chapter range. */
export function sectionsIn(chapters: ContentsEntry[], pageCount: number, chapter: ContentsRange): ContentsRange[] {
  return withRanges(chapters, pageCount).filter((r) => r.index > chapter.index && r.level === chapter.level + 1 && r.pageIndex <= chapter.end);
}

/** All chapters (study units) of the book, in order. */
export function chaptersOf(chapters: ContentsEntry[], pageCount: number): ContentsRange[] {
  const level = chapterLevel(chapters, pageCount);
  return withRanges(chapters, pageCount).filter((r) => r.level === level);
}
