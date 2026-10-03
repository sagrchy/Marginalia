import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { createWorker, OEM } from "tesseract.js";
import { openPdf } from "./extract";
import { cleanOcr } from "./ocr";

/**
 * Worker entry: render the given pages at 300 DPI and recognise their text with Tesseract (LSTM, the
 * high-accuracy English model). Posts one result per page, so progress and partial results survive a stop.
 */
const { file, password, pages, cachePath, lang } = workerData as {
  file: string;
  password: string | null;
  pages: number[];
  cachePath: string;
  lang: string;
};
const DPI = 300;
const MAX_SIDE = 4200; // keep very large pages (posters, spreads) within memory

(async () => {
  let tess: Awaited<ReturnType<typeof createWorker>> | null = null;
  try {
    fs.mkdirSync(cachePath, { recursive: true });
    const doc = await openPdf(new Uint8Array(fs.readFileSync(file)), password);
    tess = await createWorker(lang, OEM.LSTM_ONLY, {
      cachePath,
      logger: () => {},
    });
    const factory = (
      doc as unknown as {
        canvasFactory: {
          create(
            w: number,
            h: number,
          ): { canvas: { toBuffer(t: string): Buffer }; context: unknown };
          destroy(c: unknown): void;
        };
      }
    ).canvasFactory;
    for (const pageIndex of pages) {
      const page = await doc.getPage(pageIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        DPI / 72,
        MAX_SIDE / Math.max(base.width, base.height),
      );
      const vp = page.getViewport({ scale });
      const cc = factory.create(Math.round(vp.width), Math.round(vp.height));
      // "print" renders straight through without waiting on animation frames.
      await page.render({
        canvasContext: cc.context,
        canvas: cc.canvas,
        viewport: vp,
        intent: "print",
      } as never).promise;
      const png = cc.canvas.toBuffer("image/png");
      factory.destroy(cc);
      page.cleanup();
      const r = await tess.recognize(png);
      parentPort!.postMessage({
        type: "page",
        pageIndex,
        text: cleanOcr(r.data.text),
        confidence: r.data.confidence,
      });
    }
    parentPort!.postMessage({ type: "done" });
  } catch (e) {
    parentPort!.postMessage({
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await tess?.terminate().catch(() => {});
  }
})();
