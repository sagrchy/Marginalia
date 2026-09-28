import { useApp } from "../state/app";

/** Transient notices (not modal, never block reading). */
export function Flashes() {
  const flashes = useApp((s) => s.flashes);
  if (!flashes.length) return null;
  return (
    <div className="flashes" role="status" aria-live="polite">
      {flashes.map((f) => (
        <div key={f.id} className={`flash fade-in ${f.kind}`}>
          {f.text}
        </div>
      ))}
    </div>
  );
}
