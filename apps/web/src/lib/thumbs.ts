import { getDocument } from "pdfjs-dist";
import { PDF_ASSETS } from "./pdf";

/**
 * Cover thumbnails: page 1 rendered once in the browser and cached by file hash in localStorage
 * (a small JPEG), so the library never re-downloads big PDFs just to show covers.
 */
const KEY = (hash: string) => `marginalia.cover.${hash}`;
const inflight = new Map<string, Promise<string | null>>();
let queue = Promise.resolve();

export function cachedCover(hash: string): string | null {
  try {
    return localStorage.getItem(KEY(hash));
  } catch {
    return null;
  }
}

export function coverFor(bookId: number, hash: string): Promise<string | null> {
  const hit = cachedCover(hash);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(hash);
  if (!p) {
    // One at a time: several large PDFs opening at once would stall the page.
    p = new Promise<string | null>((resolve) => {
      queue = queue.then(async () => resolve(await render(bookId, hash)));
    });
    inflight.set(hash, p);
  }
  return p;
}

async function render(bookId: number, hash: string): Promise<string | null> {
  try {
    const task = getDocument({ url: `/api/books/${bookId}/file`, ...PDF_ASSETS, disableAutoFetch: true, disableStream: true, rangeChunkSize: 1 << 16 } as Parameters<typeof getDocument>[0]);
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 220 / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const url = canvas.toDataURL("image/jpeg", 0.72);
    await task.destroy();
    try {
      localStorage.setItem(KEY(hash), url);
    } catch {
      /* storage full — still show it this time */
    }
    return url;
  } catch {
    return null;
  }
}
