import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import { extractBook, PasswordRequiredError } from "./extract";

/** Worker entry: extract one book off the main thread and post progress + the result. */
const { file, password } = workerData as { file: string; password: string | null };

(async () => {
  try {
    let last = 0;
    const result = await extractBook(new Uint8Array(fs.readFileSync(file)), password, (p) => {
      if (p - last >= 0.02 || p === 1) {
        last = p;
        parentPort!.postMessage({ type: "progress", progress: p });
      }
    });
    parentPort!.postMessage({ type: "done", result });
  } catch (e) {
    parentPort!.postMessage({
      type: "error",
      message: e instanceof Error ? e.message : String(e),
      password: e instanceof PasswordRequiredError,
    });
  }
})();
