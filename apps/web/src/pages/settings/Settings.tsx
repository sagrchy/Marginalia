import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Plus, Trash2 } from "lucide-react";
import { MODELS, THEMES, THEME_LABEL, WINDOW_LABEL } from "@marginalia/shared";
import { api, type Memory, type StudyData, type Subject, type Usage } from "../../lib/api";
import { clockTime, formatDuration, fmtTokens, relTime } from "../../lib/format";
import { go } from "../../lib/router";
import { toast, toastError, useApp } from "../../state/app";
import { Dialog, Switch } from "../../components/ui";
import "./settings.css";

const TABS = [
  { id: "study", label: "Study time" },
  { id: "usage", label: "Claude usage" },
  { id: "memory", label: "Memory" },
  { id: "subjects", label: "Subjects" },
  { id: "appearance", label: "Appearance" },
  { id: "claude", label: "Claude" },
] as const;

export function SettingsPage({ tab }: { tab: string }) {
  const current = TABS.some((t) => t.id === tab) ? tab : "study";
  return (
    <div className="settings">
      <header className="topbar">
        <button className="icon-btn" onClick={() => (history.length > 1 ? history.back() : go({ name: "library" }))} aria-label="Back" title="Back">
          <ArrowLeft size={17} />
        </button>
        <span className="wordmark">Settings</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => go({ name: "library" })}>
          Library
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t.id} className={current === t.id ? "on" : ""} aria-current={current === t.id} onClick={() => go({ name: "settings", tab: t.id }, { replace: true })}>
              {t.label}
            </button>
          ))}
        </nav>
        <main className="settings-main">
          {current === "study" && <Study />}
          {current === "usage" && <UsagePanel />}
          {current === "memory" && <MemoryPanel />}
          {current === "subjects" && <Subjects />}
          {current === "appearance" && <Appearance />}
          {current === "claude" && <ClaudeSettings />}
        </main>
      </div>
    </div>
  );
}

// ---------- Study time: a year of reading, GitHub-style ----------
function Study() {
  const [data, setData] = useState<StudyData | null>(null);
  useEffect(() => {
    api.study().then(setData, toastError);
  }, []);
  if (!data) return <div className="empty">Loading…</div>;
  const t = data.totals;
  const activeDays = data.days.filter((d) => d.ms >= 60_000).length;
  return (
    <>
      <h1 className="h1">Study time</h1>
      <p className="muted small">Time with a book open and in use. Idle time (5 minutes without activity) and hidden tabs don't count.</p>
      <div className="stats">
        <Stat label="Today" value={formatDuration(t.todayMs) || "—"} />
        <Stat label="This week" value={formatDuration(t.weekMs) || "—"} />
        <Stat label="This month" value={formatDuration(t.monthMs) || "—"} />
        <Stat label="All time" value={formatDuration(t.totalMs) || "—"} />
        <Stat label="Streak" value={`${streak(data.days)} d`} />
      </div>
      <section className="card heat-card">
        <div className="row small muted" style={{ marginBottom: 10 }}>
          <span>
            {formatDuration(data.days.reduce((n, d) => n + d.ms, 0)) || "No time"} in the last year · {activeDays} active day{activeDays === 1 ? "" : "s"}
          </span>
        </div>
        <Heatmap days={data.days} />
      </section>
      {t.perBook.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h2 className="section-title">By book</h2>
          <div className="per-book">
            {t.perBook.map((b) => (
              <button key={b.bookId} className="per-book-row" onClick={() => go({ name: "book", bookId: b.bookId })}>
                <span className="truncate">{b.title}</span>
                <span className="muted small truncate">{b.subject}</span>
                <span className="per-book-bar">
                  <i style={{ width: `${(b.ms / t.perBook[0].ms) * 100}%` }} />
                </span>
                <span className="small">{formatDuration(b.ms)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function streak(days: { day: string; ms: number }[]) {
  let n = 0;
  let i = days.length - 1;
  if (days[i] && days[i].ms < 60_000) i--; // today not started yet doesn't break it
  for (; i >= 0 && days[i].ms >= 60_000; i--) n++;
  return n;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="small muted">{label}</div>
    </div>
  );
}

function level(ms: number) {
  if (ms < 60_000) return 0;
  if (ms < 20 * 60_000) return 1;
  if (ms < 60 * 60_000) return 2;
  if (ms < 2 * 60 * 60_000) return 3;
  return 4;
}

const CELL = 12;
const GAP = 3;

function Heatmap({ days }: { days: { day: string; ms: number }[] }) {
  // Columns are weeks starting Monday. As many recent weeks as fit are shown, newest on the right.
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(53);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit(Math.max(8, Math.floor((el.clientWidth - 30) / (CELL + GAP)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const all = useMemo(() => {
    if (!days.length) return [];
    const first = new Date(`${days[0].day}T00:00:00`);
    const pad = (first.getDay() + 6) % 7;
    const cells: ({ day: string; ms: number } | null)[] = [...Array(pad).fill(null), ...days];
    const out: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [days]);
  const weeks = all.slice(-fit);
  const months = weeks.map((w, i) => {
    const d = w.find(Boolean);
    if (!d) return "";
    const m = new Date(`${d.day}T00:00:00`);
    const prev = weeks[i - 1]?.find(Boolean);
    if (!prev) return "";
    return new Date(`${prev.day}T00:00:00`).getMonth() !== m.getMonth() ? m.toLocaleDateString(undefined, { month: "short" }) : "";
  });
  return (
    <div className="heat-wrap" ref={ref}>
      <div className="heat" style={{ gridTemplateColumns: `28px repeat(${weeks.length}, ${CELL}px)`, gridTemplateRows: `14px repeat(7, ${CELL}px)`, gap: GAP }}>
        {["Mon", "Wed", "Fri"].map((d, k) => (
          <span key={d} className="heat-day small muted" style={{ gridColumn: 1, gridRow: 2 + k * 2 }}>
            {d}
          </span>
        ))}
        {weeks.map((_, i) =>
          months[i] ? (
            <span key={`m${i}`} className="heat-month small muted" style={{ gridColumn: `${i + 2} / span 4`, gridRow: 1 }}>
              {months[i]}
            </span>
          ) : null,
        )}
        {weeks.flatMap((w, i) =>
          Array.from({ length: 7 }, (_, j) => {
            const c = w[j];
            const pos = { gridColumn: i + 2, gridRow: j + 2 };
            if (!c) return <span key={`${i}-${j}`} className="cell empty" style={pos} />;
            const date = new Date(`${c.day}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
            return <span key={`${i}-${j}`} className={`cell l${level(c.ms)}`} style={pos} title={`${c.ms >= 60_000 ? formatDuration(c.ms) : "No study"} · ${date}`} />;
          }),
        )}
      </div>
      <div className="heat-legend small muted">
        Less
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`cell l${l}`} />
        ))}
        More
      </div>
    </div>
  );
}

// ---------- Claude usage ----------
function UsagePanel() {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    api.usage().then(setU, toastError);
  }, []);
  if (!u) return <div className="empty">Loading…</div>;
  return (
    <>
      <h1 className="h1">Claude usage</h1>
      <p className="muted small">
        Marginalia uses Claude Code with your Claude subscription{u.account?.subscription ? ` (${u.account.subscription})` : ""}
        {u.account?.email ? ` — signed in as ${u.account.email}` : ""}. Studying counts toward the same limits as Claude Code and claude.ai.
      </p>
      <section className="card pad">
        <h2 className="section-title">Plan limits</h2>
        {u.limits.length === 0 ? (
          <p className="muted small">Shown after your first message to Claude.</p>
        ) : (
          <div className="limits">
            {u.limits.map((l) => (
              <div key={l.window} className="limit">
                <div className="row small">
                  <span>{WINDOW_LABEL[l.window] ?? l.window}</span>
                  <span className="spacer" />
                  <span className={l.status === "allowed" ? "muted" : "danger"}>
                    {l.utilization != null ? `${Math.round(l.utilization * 100)}% used` : l.status === "rejected" ? "Reached" : l.status === "allowed_warning" ? "Getting close" : "OK"}
                  </span>
                </div>
                {(l.utilization != null || l.status === "rejected") && (
                  <div className="progress" style={{ marginTop: 5 }}>
                    <i style={{ width: `${Math.round((l.utilization ?? 1) * 100)}%` }} />
                  </div>
                )}
                {l.resetsAt && (
                  <div className="small muted" style={{ marginTop: 4 }}>
                    Resets {new Date(l.resetsAt).toDateString() === new Date().toDateString() ? `at ${clockTime(l.resetsAt)}` : new Date(l.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                  </div>
                )}
              </div>
            ))}
            <div className="small muted">Updated {relTime(Math.max(...u.limits.map((l) => l.updatedAt)))}</div>
          </div>
        )}
      </section>
      <div className="stats" style={{ marginTop: 16 }}>
        <Stat label="Messages today" value={String(u.today.n)} />
        <Stat label="Tokens today" value={fmtTokens(u.today.inTok + u.today.outTok)} />
        <Stat label="Messages this week" value={String(u.week.n)} />
        <Stat label="Tokens this week" value={fmtTokens(u.week.inTok + u.week.outTok)} />
      </div>
      {u.byModel.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h2 className="section-title">This week by model</h2>
          <table className="table small">
            <tbody>
              {u.byModel.map((m) => (
                <tr key={m.model}>
                  <td>{MODELS.find((x) => x.id === m.model)?.label ?? m.model}</td>
                  <td>{m.n} messages</td>
                  <td>{fmtTokens(m.tokens)} tokens</td>
                  <td className="muted" title="What this would cost at API prices — your subscription covers it">
                    ≈ ${m.cost.toFixed(2)} API-equivalent
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

// ---------- Memory ----------
function MemoryPanel() {
  const subjects = useApp((s) => s.subjects);
  const [items, setItems] = useState<Memory[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.memories().then(setItems, toastError);
  useEffect(() => {
    void load();
  }, []);
  if (!items) return <div className="empty">Loading…</div>;
  const pending = items.filter((m) => m.status === "proposed");
  const approved = items.filter((m) => m.status === "approved");
  const dismissed = items.filter((m) => m.status === "dismissed");
  return (
    <>
      <div className="row">
        <h1 className="h1">Memory</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add
        </button>
      </div>
      <p className="muted small">
        Things Claude knows about you across every session — how you like explanations, what you've mastered, what trips you up. Claude can only suggest memories; nothing is saved until you approve it.
      </p>
      {pending.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <h2 className="section-title">Waiting for you</h2>
          <div className="mem-list">
            {pending.map((m) => (
              <MemoryRow key={m.id} m={m} onChange={load} />
            ))}
          </div>
        </section>
      )}
      <section style={{ marginTop: 18 }}>
        <h2 className="section-title">Saved</h2>
        {approved.length === 0 ? (
          <p className="muted small">Nothing saved yet.</p>
        ) : (
          <div className="mem-list">
            {approved.map((m) => (
              <MemoryRow key={m.id} m={m} onChange={load} />
            ))}
          </div>
        )}
      </section>
      {dismissed.length > 0 && (
        <details style={{ marginTop: 18 }}>
          <summary className="small muted" style={{ cursor: "pointer" }}>
            Dismissed ({dismissed.length})
          </summary>
          <div className="mem-list" style={{ marginTop: 8 }}>
            {dismissed.map((m) => (
              <MemoryRow key={m.id} m={m} onChange={load} />
            ))}
          </div>
        </details>
      )}
      {adding && <AddMemory subjects={subjects} onClose={() => setAdding(false)} onDone={load} />}
    </>
  );
}

function MemoryRow({ m, onChange }: { m: Memory; onChange: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const where = [m.subject, m.book, m.session].filter(Boolean).join(" · ");
  const save = async (p: { text?: string; status?: "approved" | "dismissed" }) => {
    await api.patchMemory(m.id, p).catch(toastError);
    onChange();
  };
  return (
    <div className={`mem card${m.status === "proposed" ? " pending" : ""}`}>
      {edit != null ? (
        <textarea className="textarea" rows={3} autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} />
      ) : (
        <div className="mem-text" onDoubleClick={() => setEdit(m.text)}>
          {m.text}
        </div>
      )}
      <div className="row small muted" style={{ marginTop: 6, flexWrap: "wrap" }}>
        <span>
          {m.source === "user" ? "Added by you" : "Suggested by Claude"}
          {where ? ` · ${where}` : ""} · {relTime(m.createdAt)}
        </span>
        <span className="spacer" />
        {edit != null ? (
          <>
            <button className="btn sm ghost" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button
              className="btn sm primary"
              onClick={async () => {
                const t = edit.trim();
                setEdit(null);
                if (t && t !== m.text) await save({ text: t });
              }}
            >
              Save
            </button>
          </>
        ) : (
          <>
            {m.status !== "approved" && (
              <button className="btn sm primary" onClick={() => save({ status: "approved" })}>
                <Check size={13} /> Approve
              </button>
            )}
            <button className="btn sm ghost" onClick={() => setEdit(m.text)}>
              Edit
            </button>
            {m.status === "proposed" && (
              <button className="btn sm ghost" onClick={() => save({ status: "dismissed" })}>
                Dismiss
              </button>
            )}
            <button
              className="icon-btn"
              aria-label="Delete memory"
              onClick={async () => {
                await api.deleteMemory(m.id).catch(toastError);
                onChange();
              }}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AddMemory({ subjects, onClose, onDone }: { subjects: Subject[]; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [subjectId, setSubjectId] = useState<number | null>(null);
  return (
    <Dialog title="Add a memory" onClose={onClose} width={480}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await api.addMemory(text.trim(), subjectId).catch(toastError);
          onDone();
          onClose();
        }}
      >
        <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. I prefer geometric intuition before formal proofs." aria-label="Memory" />
        <div className="field" style={{ marginTop: 10 }}>
          <label className="label" htmlFor="mem-subject">
            Applies to
          </label>
          <select id="mem-subject" className="select" value={subjectId ?? ""} onChange={(e) => setSubjectId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Every subject</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- Subjects and tutor style ----------
function Subjects() {
  const subjects = useApp((s) => s.subjects);
  const loadSubjects = useApp((s) => s.loadSubjects);
  const [sel, setSel] = useState<number | null>(subjects[0]?.id ?? null);
  const s = subjects.find((x) => x.id === sel) ?? subjects[0];
  const [name, setName] = useState(s?.name ?? "");
  const [style, setStyle] = useState(s?.tutorStyle ?? "");
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    setName(s?.name ?? "");
    setStyle(s?.tutorStyle ?? "");
  }, [s?.id, s?.name, s?.tutorStyle]);
  const dirty = s && (name.trim() !== s.name || style !== s.tutorStyle);
  return (
    <>
      <div className="row">
        <h1 className="h1">Subjects</h1>
        <span className="spacer" />
        <button
          className="btn"
          onClick={async () => {
            try {
              const n = await api.addSubject("New subject");
              await loadSubjects();
              setSel(n.id);
            } catch (e) {
              toastError(e);
            }
          }}
        >
          <Plus size={14} /> Add subject
        </button>
      </div>
      <p className="muted small">Each subject has a tutor style — how Claude should teach it. Claude reads it at the start of every session for books in that subject.</p>
      {s ? (
        <div className="subjects">
          <div className="subject-list">
            {subjects.map((x) => (
              <button key={x.id} className={x.id === s.id ? "on" : ""} onClick={() => setSel(x.id)}>
                {x.name}
              </button>
            ))}
          </div>
          <div className="subject-edit">
            <div className="field">
              <label className="label" htmlFor="sub-name">
                Name
              </label>
              <input id="sub-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="sub-style">
                Tutor style
              </label>
              <textarea id="sub-style" className="textarea mono style-text" rows={16} value={style} onChange={(e) => setStyle(e.target.value)} />
              <div className="hint">Plain language or Markdown. For example: “Give hints before answers. Ask me to state theorems in my own words.”</div>
            </div>
            <div className="row">
              <button className="btn ghost danger" onClick={() => setConfirmDel(true)}>
                Delete subject
              </button>
              <span className="spacer" />
              {dirty && (
                <button
                  className="btn"
                  onClick={() => {
                    setName(s.name);
                    setStyle(s.tutorStyle);
                  }}
                >
                  Discard
                </button>
              )}
              <button
                className="btn primary"
                disabled={!dirty || !name.trim()}
                onClick={async () => {
                  try {
                    await api.patchSubject(s.id, { name: name.trim(), tutorStyle: style });
                    await loadSubjects();
                    toast({ text: "Saved. New messages will use this style." });
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">No subjects yet.</p>
      )}
      {confirmDel && s && (
        <Dialog title={`Delete “${s.name}”?`} onClose={() => setConfirmDel(false)}>
          <p>The subject and its tutor style will be removed. A subject that still has books can't be deleted — move them first.</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setConfirmDel(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                setConfirmDel(false);
                try {
                  await api.deleteSubject(s.id);
                  const rest = await loadSubjects();
                  setSel(rest[0]?.id ?? null);
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

// ---------- Appearance ----------
function Appearance() {
  const settings = useApp((s) => s.settings)!;
  const save = useApp((s) => s.save);
  const a = settings.appearance;
  return (
    <>
      <h1 className="h1">Appearance</h1>
      <section className="set-row">
        <div>
          <div className="set-label">Theme</div>
          <div className="small muted">Book pages always keep their original colours.</div>
        </div>
        <div className="themes">
          {THEMES.map((t) => (
            <button key={t} className={`theme-swatch t-${t}${a.theme === t ? " on" : ""}`} onClick={() => void save({ appearance: { theme: t } })} aria-pressed={a.theme === t}>
              <span className="sw">
                <i />
                <i />
              </span>
              {THEME_LABEL[t]}
            </button>
          ))}
        </div>
      </section>
      <section className="set-row">
        <div>
          <div className="set-label">Text size</div>
          <div className="small muted">For Claude's answers and notes.</div>
        </div>
        <div className="row">
          <input type="range" min={13} max={22} value={a.fontSize} onChange={(e) => void save({ appearance: { fontSize: Number(e.target.value) } })} aria-label="Text size" />
          <span className="small" style={{ width: 40 }}>
            {a.fontSize}px
          </span>
        </div>
      </section>
      <div className="md sample" style={{ marginBottom: 20 }}>
        A continuous function on a closed interval attains a maximum; the proof leans on the least upper bound property.
      </div>
      <section className="set-row">
        <div>
          <div className="set-label">Dim book pages</div>
          <div className="small muted">Lowers page brightness for night reading without inverting colours, so figures and highlights stay accurate.</div>
        </div>
        <div className="row">
          <input type="range" min={0} max={40} value={a.pdfDim} onChange={(e) => void save({ appearance: { pdfDim: Number(e.target.value) } })} aria-label="Dim book pages" />
          <span className="small" style={{ width: 40 }}>
            {a.pdfDim ? `${a.pdfDim}%` : "Off"}
          </span>
        </div>
      </section>
      <div className="dim-preview">
        <div className="dim-page">
          <b>Theorem 1.</b> If f is continuous on [a, b], then f is bounded above on [a, b].
        </div>
      </div>
    </>
  );
}

// ---------- Claude ----------
function ClaudeSettings() {
  const info = useApp((s) => s.info)!;
  const settings = useApp((s) => s.settings)!;
  const save = useApp((s) => s.save);
  return (
    <>
      <h1 className="h1">Claude</h1>
      <p className="muted small">
        Each session is a Claude Code conversation that runs in Marginalia's study folder. Claude can read your books, notes and highlights there and search the web. It can't run commands, and it can only write
        session notes and memory suggestions.
      </p>
      <section className="set-row">
        <div>
          <div className="set-label">Model</div>
          <div className="small muted">Used for every message.</div>
        </div>
        <select className="select" style={{ width: 260 }} value={settings.model} onChange={(e) => void save({ model: e.target.value }).catch(toastError)} aria-label="Model">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.note}
            </option>
          ))}
        </select>
      </section>
      <section className="set-row">
        <div>
          <div className="set-label">“Deeper” model</div>
          <div className="small muted">Used when you turn on Deeper for a message.</div>
        </div>
        <select className="select" style={{ width: 260 }} value={settings.deepModel} onChange={(e) => void save({ deepModel: e.target.value }).catch(toastError)} aria-label="Deeper model">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </section>
      <section className="set-row">
        <div>
          <div className="set-label">Web search</div>
          <div className="small muted">Let Claude look things up online when the book isn't enough. Web pages are treated as information, never as instructions.</div>
        </div>
        <Switch on={settings.webSearch} onChange={(v) => void save({ webSearch: v }).catch(toastError)} label="Web search" />
      </section>
      <section className="set-row">
        <div>
          <div className="set-label">Lookups per message</div>
          <div className="small muted">The most pages, searches and web fetches Claude may use to answer one message.</div>
        </div>
        <div className="row">
          <input type="range" min={3} max={40} value={settings.maxTurns} onChange={(e) => void save({ maxTurns: Number(e.target.value) })} aria-label="Lookups per message" />
          <span className="small" style={{ width: 30 }}>
            {settings.maxTurns}
          </span>
        </div>
      </section>
      <section className="set-row">
        <div>
          <div className="set-label">Study folder</div>
          <div className="small muted">
            Open a terminal here and run <code>claude</code> to study outside the app, or use “Copy terminal command” on a session to continue it in Claude Code.
          </div>
        </div>
        <button
          className="btn sm"
          onClick={() => void navigator.clipboard.writeText(info.workspace).then(() => toast({ text: "Path copied." }))}
          title={info.workspace}
        >
          Copy path
        </button>
      </section>
      <div className="small muted" style={{ marginTop: 16 }}>
        Data: <span className="mono">{info.dataDir}</span>
        {info.engine !== "agent" && <> · engine: {info.engine}</>}
        {info.legacy && (
          <>
            {" "}
            · imported {info.legacy.books} books and {info.legacy.sessions} sessions from v1 {relTime(info.legacy.at)}
          </>
        )}
      </div>
    </>
  );
}
