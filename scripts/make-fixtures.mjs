// Generates the test PDFs in fixtures/:
//   calculus-sample.pdf  born-digital, 8 pages, with an outline (chapters and sections)
//   scanned-sample.pdf   image-only pages (no text layer), made by rasterizing the first PDF
// Usage: node scripts/make-fixtures.mjs
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from "pdf-lib";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = path.resolve("fixtures");
fs.mkdirSync(out, { recursive: true });

const PAGES = [
  { ch: "Chapter 7 Continuity", sec: "7.1 Limits and continuity", body: [
    "A function f is continuous at a if lim_{x->a} f(x) = f(a).",
    "Equivalently: for every epsilon > 0 there is a delta > 0 such that",
    "|x - a| < delta implies |f(x) - f(a)| < epsilon.",
    "The order of the quantifiers matters: delta is chosen after epsilon and after a.",
  ] },
  { sec: "7.1 Limits and continuity", body: [
    "Example. f(x) = x^2 is continuous at every a.",
    "Given epsilon > 0, choose delta = min(1, epsilon / (2|a| + 1)).",
    "Then |x^2 - a^2| = |x - a| |x + a| < delta (2|a| + 1) <= epsilon.",
    "Notice that delta depends on a as well as on epsilon.",
  ] },
  { sec: "7.2 Three hard theorems", body: [
    "Theorem 1. If f is continuous on [a, b] and f(a) < 0 < f(b),",
    "then there is some x in [a, b] with f(x) = 0.",
    "Theorem 2. If f is continuous on [a, b], then f is bounded above on [a, b].",
    "Theorem 3. If f is continuous on [a, b], then there is some y in [a, b]",
    "such that f(y) >= f(x) for all x in [a, b].",
  ] },
  { sec: "7.2 Three hard theorems", body: [
    "The intermediate value theorem follows from Theorem 1 applied to f - c.",
    "These theorems fail on open intervals: f(x) = 1/x on (0, 1) is unbounded.",
    "The proofs require the least upper bound property of the real numbers.",
  ] },
  { sec: "7.3 Uniform continuity", body: [
    "Definition. f is uniformly continuous on an interval A if for every epsilon > 0",
    "there is some delta > 0 such that, for all x and y in A,",
    "if |x - y| < delta, then |f(x) - f(y)| < epsilon.",
    "Here delta may depend on epsilon but not on x or y.",
  ] },
  { sec: "7.3 Uniform continuity", body: [
    "Theorem. If f is continuous on [a, b], then f is uniformly continuous on [a, b].",
    "The function f(x) = 1/x is continuous but not uniformly continuous on (0, 1).",
    "The closed interval is essential: compactness lets a single delta work everywhere.",
  ] },
  { ch: "Chapter 8 Least Upper Bounds", sec: "8.1 The least upper bound property", body: [
    "Every nonempty set of real numbers that is bounded above has a least upper bound.",
    "This property distinguishes the real numbers from the rational numbers.",
    "The set { x : x^2 < 2 } has no least upper bound in the rationals.",
  ] },
  { sec: "8.1 The least upper bound property", body: [
    "Using the least upper bound property we can now prove Theorem 1 of Chapter 7.",
    "Let A = { x in [a, b] : f is negative on [a, x] } and let alpha = sup A.",
    "Problems. 1. Prove that alpha is in (a, b). 2. Prove that f(alpha) = 0.",
  ] },
];

const doc = await PDFDocument.create();
doc.setTitle("Calculus Sample");
doc.setAuthor("Marginalia Fixtures");
const font = await doc.embedFont(StandardFonts.TimesRoman);
const bold = await doc.embedFont(StandardFonts.TimesRomanBold);

PAGES.forEach((p, i) => {
  const page = doc.addPage([612, 792]);
  let y = 720;
  if (p.ch) {
    page.drawText(p.ch, { x: 72, y, size: 22, font: bold, color: rgb(0, 0, 0) });
    y -= 40;
  }
  page.drawText(p.sec, { x: 72, y, size: 15, font: bold });
  y -= 30;
  for (const line of p.body) {
    page.drawText(line, { x: 72, y, size: 12, font });
    y -= 20;
  }
  page.drawText(String(141 + i), { x: 300, y: 40, size: 10, font });
});

// Outline: chapters with sections as children.
const pageRefs = doc.getPages().map((p) => p.ref);
const ctx = doc.context;
const entries = [];
let chapter = null;
PAGES.forEach((p, i) => {
  if (p.ch) {
    chapter = { title: p.ch, page: i, children: [] };
    entries.push(chapter);
  }
  if (!chapter.children.find((c) => c.title === p.sec)) chapter.children.push({ title: p.sec, page: i, children: [] });
});
const outlinesRef = ctx.nextRef();
function build(items, parentRef) {
  const refs = items.map(() => ctx.nextRef());
  items.forEach((it, k) => {
    const dict = ctx.obj({
      Title: PDFString.of(it.title),
      Parent: parentRef,
      Dest: ctx.obj([pageRefs[it.page], PDFName.of("XYZ"), null, null, null]),
    });
    if (k > 0) dict.set(PDFName.of("Prev"), refs[k - 1]);
    if (k < items.length - 1) dict.set(PDFName.of("Next"), refs[k + 1]);
    if (it.children.length) {
      const kids = build(it.children, refs[k]);
      dict.set(PDFName.of("First"), kids[0]);
      dict.set(PDFName.of("Last"), kids[kids.length - 1]);
      dict.set(PDFName.of("Count"), PDFNumber.of(it.children.length));
    }
    ctx.assign(refs[k], dict);
  });
  return refs;
}
const top = build(entries, outlinesRef);
ctx.assign(
  outlinesRef,
  ctx.obj({ Type: "Outlines", First: top[0], Last: top[top.length - 1], Count: PDFNumber.of(entries.length) }),
);
doc.catalog.set(PDFName.of("Outlines"), outlinesRef);

const bornDigital = path.join(out, "calculus-sample.pdf");
fs.writeFileSync(bornDigital, await doc.save({ useObjectStreams: false }));
console.log("wrote", bornDigital);

// Scanned: rasterize the first 3 pages and embed them as images with no text layer.
const scanned = await PDFDocument.create();
scanned.setTitle("Scanned Sample");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-fx-"));
let rasterized = false;
try {
  execFileSync("pdftoppm", ["-png", "-r", "60", "-f", "1", "-l", "3", bornDigital, path.join(tmp, "p")], { stdio: "ignore" });
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".png")).sort();
  for (const f of files) {
    const img = await scanned.embedPng(fs.readFileSync(path.join(tmp, f)));
    const page = scanned.addPage([612, 792]);
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  rasterized = files.length > 0;
} catch {
  rasterized = false;
}
if (!rasterized) {
  // Fallback without poppler: shapes only, still no text layer.
  for (let i = 0; i < 3; i++) {
    const page = scanned.addPage([612, 792]);
    for (let l = 0; l < 20; l++) page.drawRectangle({ x: 72, y: 700 - l * 24, width: 300 + ((l * 37) % 160), height: 8, color: rgb(0.2, 0.2, 0.2) });
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
const scannedPath = path.join(out, "scanned-sample.pdf");
fs.writeFileSync(scannedPath, await scanned.save());
console.log("wrote", scannedPath, rasterized ? "(rasterized)" : "(synthetic)");

// ---------- Edge cases ----------
const lorem = (n, seed = 1) => {
  const words = "the function limit value interval continuity proof theorem define consider point sequence bounded number real every there exists such that therefore".split(" ");
  let s = seed;
  return Array.from({ length: n }, () => words[(s = (s * 9301 + 49297) % 233280) % words.length]).join(" ");
};
const wrap = (text, width) => {
  const out = [];
  let line = "";
  for (const w of text.split(" ")) {
    if ((line + " " + w).length > width) (out.push(line), (line = w));
    else line = line ? line + " " + w : w;
  }
  if (line) out.push(line);
  return out;
};

// 1. No outline; roman front matter; a printed Contents page; running headers and page-number footers.
{
  const d = await PDFDocument.create();
  d.setTitle("Microsoft Word - notes_final_v3.docx");
  const f = await d.embedFont(StandardFonts.TimesRoman);
  const fb = await d.embedFont(StandardFonts.TimesRomanBold);
  const roman = ["i", "ii", "iii", "iv"];
  const chapters = [
    ["1 Sets and Functions", 1],
    ["1.1 Sets", 1],
    ["1.2 Functions", 4],
    ["2 Sequences", 7],
    ["2.1 Convergence", 7],
    ["2.2 Cauchy Sequences", 10],
  ];
  for (let i = 0; i < 4; i++) {
    const p = d.addPage([432, 648]);
    if (i === 1) {
      p.drawText("Contents", { x: 54, y: 580, size: 20, font: fb });
      chapters.forEach(([t, n], k) => p.drawText(`${t} ${".".repeat(Math.max(4, 50 - t.length))} ${n}`, { x: t.match(/^\d\.\d/) ? 72 : 54, y: 540 - k * 20, size: 11, font: f }));
    } else p.drawText(i === 0 ? "Lecture Notes on Analysis" : "Preface. " + lorem(20, i), { x: 54, y: 560, size: i === 0 ? 22 : 11, font: i === 0 ? fb : f });
    p.drawText(roman[i], { x: 210, y: 30, size: 10, font: f });
  }
  for (let n = 1; n <= 12; n++) {
    const p = d.addPage([432, 648]);
    const ch = [...chapters].reverse().find(([, s]) => s <= n);
    p.drawText(n % 2 ? `SEQUENCES AND SERIES` : `Lecture Notes on Analysis`, { x: 54, y: 612, size: 9, font: f });
    let y = 570;
    if (chapters.some(([, s]) => s === n)) {
      for (const [t] of chapters.filter(([, s]) => s === n)) {
        p.drawText(t, { x: 54, y, size: t.match(/^\d\.\d/) ? 14 : 18, font: fb });
        y -= 30;
      }
    }
    for (const l of wrap(lorem(160, n * 7) + (n === 5 ? " uniformly continuous functions preserve Cauchy sequences" : ""), 70)) {
      if (y < 60) break;
      p.drawText(l, { x: 54, y, size: 11, font: f });
      y -= 15;
    }
    p.drawText(String(n), { x: 210, y: 30, size: 10, font: f });
    void ch;
  }
  fs.writeFileSync(path.join(out, "no-outline-contents.pdf"), await d.save());
  console.log("wrote no-outline-contents.pdf");
}

// 2. Headings only: no outline, no contents page, big "Chapter N" headings.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const fb = await d.embedFont(StandardFonts.HelveticaBold);
  for (let n = 0; n < 9; n++) {
    const p = d.addPage([432, 648]);
    let y = 590;
    if (n % 3 === 0) {
      p.drawText(`Chapter ${n / 3 + 1}`, { x: 54, y, size: 24, font: fb });
      y -= 40;
      p.drawText(["Neurons and Glia", "Synaptic Transmission", "Neural Circuits"][n / 3], { x: 54, y, size: 18, font: fb });
      y -= 36;
    }
    for (const l of wrap(lorem(170, n + 3), 66)) {
      if (y < 60) break;
      p.drawText(l, { x: 54, y, size: 11, font: f });
      y -= 15;
    }
  }
  fs.writeFileSync(path.join(out, "headings-only.pdf"), await d.save());
  console.log("wrote headings-only.pdf");
}

// 3. Two-column paper.
{
  const d = await PDFDocument.create();
  d.setTitle("Attention in Cortical Circuits");
  d.setAuthor("A. Researcher");
  const f = await d.embedFont(StandardFonts.TimesRoman);
  const fb = await d.embedFont(StandardFonts.TimesRomanBold);
  for (let n = 0; n < 2; n++) {
    const p = d.addPage([612, 792]);
    if (n === 0) p.drawText("Attention in Cortical Circuits", { x: 150, y: 730, size: 20, font: fb });
    const left = wrap(`LEFTCOLUMN ${lorem(260, n + 11)} ENDLEFT`, 44);
    const right = wrap(`RIGHTCOLUMN ${lorem(260, n + 21)} ENDRIGHT`, 44);
    left.forEach((l, k) => 690 - k * 13 > 50 && p.drawText(l, { x: 50, y: 690 - k * 13, size: 10, font: f }));
    right.forEach((l, k) => 690 - k * 13 > 50 && p.drawText(l, { x: 320, y: 690 - k * 13, size: 10, font: f }));
  }
  fs.writeFileSync(path.join(out, "two-column.pdf"), await d.save());
  console.log("wrote two-column.pdf");
}

// 4. Not a PDF (an EPUB-looking zip).
fs.writeFileSync(path.join(out, "not-a-book.epub"), Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("mimetypeapplication/epub+zip")]));
console.log("wrote not-a-book.epub");
