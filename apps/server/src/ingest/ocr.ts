/**
 * Text recognition (OCR) for pages without a usable text layer: scans, and PDFs whose fonts have no
 * character map. Tesseract's high-accuracy English model runs locally (downloaded once, ~5 MB); no plan
 * usage. Pages it isn't confident about stay marked so Claude looks at the page image instead.
 */
export const ocrEnabled = () => process.env.MARGINALIA_OCR !== "off";

/** Below this (Tesseract's 0–100 confidence) the text is kept for search but flagged as unreliable. */
export const OCR_MIN_CONFIDENCE = 60;

export type OcrPage = { pageIndex: number; text: string; confidence: number };

/** Tidy OCR output: join words hyphenated across lines, drop stray single characters, collapse blank runs. */
export function cleanOcr(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/([A-Za-z]{2,})-\n([a-z]{2,})/g, "$1$2")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(
      (l, i, a) =>
        !(l.length === 1 && !/[\dA-Za-z]/.test(l)) &&
        !(l === "" && a[i - 1] === ""),
    )
    .join("\n")
    .trim();
}

/** The printed page number, when the page's first or last line is just a number (or a roman numeral). */
export function ocrPageNumber(text: string): {
  arabic: number | null;
  roman: string | null;
} {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of [lines[lines.length - 1], lines[0]]) {
    if (!l) continue;
    if (/^\d{1,4}$/.test(l)) return { arabic: Number(l), roman: null };
    if (/^[ivxlc]{1,7}$/i.test(l))
      return { arabic: null, roman: l.toLowerCase() };
  }
  return { arabic: null, roman: null };
}
