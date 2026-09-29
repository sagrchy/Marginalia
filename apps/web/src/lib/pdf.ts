import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Everything pdf.js needs to render like a full PDF viewer: font maps, standard fonts, colour profiles, image decoders. */
export const PDF_ASSETS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
};

export class PdfPasswordError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? "Incorrect password" : "Password required");
  }
}

export async function openPdf(url: string, password?: string | null): Promise<PDFDocumentProxy> {
  const task = getDocument({
    url,
    password: password ?? undefined,
    ...PDF_ASSETS,
    isEvalSupported: false,
    // Fetch in ranges so a large book shows its first page quickly.
    rangeChunkSize: 1 << 18,
    disableAutoFetch: false,
    enableXfa: true,
  } as Parameters<typeof getDocument>[0]);
  try {
    return await task.promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === "PasswordException") throw new PdfPasswordError(err.code === 2);
    throw e;
  }
}
