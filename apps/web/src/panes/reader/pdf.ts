import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

let current: { bookId: number; doc: PDFDocumentProxy } | null = null;
let loading: { bookId: number; promise: Promise<PDFDocumentProxy> } | null = null;

/** One open document at a time, shared by the reader, page capture and vision OCR. */
export function loadPdf(bookId: number): Promise<PDFDocumentProxy> {
  if (current?.bookId === bookId) return Promise.resolve(current.doc);
  if (loading?.bookId === bookId) return loading.promise;
  const promise = getDocument({ url: `/api/books/${bookId}/file`, isEvalSupported: false } as Parameters<typeof getDocument>[0]).promise.then((doc) => {
    if (current && current.bookId !== bookId) void current.doc.loadingTask.destroy();
    current = { bookId, doc };
    loading = null;
    return doc;
  });
  loading = { bookId, promise };
  promise.catch(() => (loading = null));
  return promise;
}

export function currentPdf(): PDFDocumentProxy | null {
  return current?.doc ?? null;
}
