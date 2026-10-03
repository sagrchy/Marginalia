import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { embedPassages, toBlob } from "./embed";

/**
 * Worker entry: compute meaning-search vectors for one book's passages that don't have one yet.
 * Uses its own database connection (WAL mode) and posts progress; the server stays responsive.
 */
const { dbFile, dataDir, bookId } = workerData as { dbFile: string; dataDir: string; bookId: number };
const BATCH = 8;

(async () => {
  const db = new Database(dbFile);
  db.pragma("busy_timeout = 5000");
  try {
    const total = (db.prepare("select count(*) n from passages where book_id = ?").get(bookId) as { n: number }).n;
    const todo = db.prepare("select id, text from passages where book_id = ? and embedding is null order by id").all(bookId) as { id: number; text: string }[];
    const save = db.prepare("update passages set embedding = ? where id = ?");
    let done = total - todo.length;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const vecs = await embedPassages(dataDir, batch.map((p) => p.text.slice(0, 1500)));
      db.transaction(() => batch.forEach((p, k) => save.run(toBlob(vecs[k]), p.id)))();
      done += batch.length;
      parentPort!.postMessage({ type: "progress", progress: total ? done / total : 1 });
    }
    parentPort!.postMessage({ type: "done" });
  } catch (e) {
    parentPort!.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    db.close();
  }
})();
