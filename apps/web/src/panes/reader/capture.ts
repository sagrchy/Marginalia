import { currentPdf } from "./pdf";

/**
 * Render a page to a downscaled PNG (base64, no data: prefix) for page-image mode (TU-8) and the
 * vision OCR engine. Text is always preferred; images are sent only when enabled.
 */
export async function capturePageImage(pageIndex: number, maxWidth = 1000): Promise<string> {
  const doc = currentPdf();
  if (!doc) throw new Error("No document loaded");
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxWidth / base.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}
