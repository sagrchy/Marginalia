import { useEffect, useRef, useState } from "react";
import { ProfilePreset, TutorProfile, type WeekReview } from "@marginalia/shared";
import { api, type Concept, type Evidence, type Subject, type WeekRow } from "../../api/client";
import { Empty, ErrorState, Loading, Masthead, RuleBar, SmallCapsButton, fmtDate } from "../../components/primitives";
import { useApp } from "../../state/app";
import "./subject-desk.css";

/** Subject Desk (6.2): tutor profile, stated preferences, concepts and weekly targets. */
export function SubjectDesk({ subjectId }: { subjectId: number }) {
  const [subject, setSubject] = useState<Subject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"profile" | "concepts" | "targets" | "history">("profile");

  useEffect(() => {
    api
      .subjects()
      .then((ss) => {
        const s = ss.find((x) => x.id === subjectId);
        if (!s) throw new Error("Subject not found");
        setSubject(s);
      })
      .catch((e) => setError(e.message));
  }, [subjectId]);

  if (error) return <div className="page-wrap"><Masthead compact /><ErrorState title="Subject desk unavailable">{error}</ErrorState></div>;
  if (!subject) return <div className="page-wrap"><Masthead compact /><Loading /></div>;

  return (
    <div className="page-wrap desk">
      <Masthead compact subtitle={<span className="meta">Subject desk</span>} />
      <h2 className="display desk-title">{subject.name}</h2>
      <nav className="btn-row hairlines desk-tabs">
        {(["profile", "concepts", "targets", "history"] as const).map((t) => (
          <button key={t} className={`sc-btn${tab === t ? " strong" : ""}`} onClick={() => setTab(t)}>
            {t === "profile" ? "Tutor profile" : t === "concepts" ? "Concepts" : t === "targets" ? "Weekly targets" : "Sessions"}
          </button>
        ))}
      </nav>
      {tab === "profile" && <ProfileForm subject={subject} />}
      {tab === "concepts" && <Concepts subject={subject} />}
      {tab === "targets" && <Targets subject={subject} />}
      {tab === "history" && <History subject={subject} />}
    </div>
  );
}

/** TP-1/3/4 and LM-4: the profile is data, edited in a form, importable and exportable. */
function ProfileForm({ subject }: { subject: Subject }) {
  const [p, setP] = useState<TutorProfile | null>(null);
  const [overrides, setOverrides] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const prof = await api.profile(subject.id);
    setP(prof);
    setOverrides(JSON.stringify(prof.session_type_overrides, null, 2));
  };
  useEffect(() => {
    void load();
  }, [subject.id]);
  if (!p) return <Loading />;

  const save = async () => {
    try {
      const sto = JSON.parse(overrides || "{}");
      const parsed = TutorProfile.parse({ ...p, session_type_overrides: sto });
      setP(await api.saveProfile(subject.id, parsed));
      setErr(null);
      useApp.getState().flash("Profile saved.");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const list = (key: "rules" | "preferences", label: string, placeholder: string) => (
    <label className="field">
      <span>{label} (one per line)</span>
      <textarea rows={key === "rules" ? 6 : 3} value={p[key].join("\n")} placeholder={placeholder} onChange={(e) => setP({ ...p, [key]: e.target.value.split("\n") })} onBlur={() => setP({ ...p, [key]: p[key].map((x) => x.trim()).filter(Boolean) })} />
    </label>
  );

  return (
    <div className="desk-grid">
      <div>
        <label className="field">
          <span>Name</span>
          <input type="text" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Persona</span>
          <textarea rows={3} value={p.persona} onChange={(e) => setP({ ...p, persona: e.target.value })} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Pedagogy style</span>
            <select value={p.style} onChange={(e) => setP({ ...p, style: e.target.value as TutorProfile["style"] })}>
              <option value="socratic">Socratic</option>
              <option value="explainer">Explainer</option>
              <option value="interlocutor">Interlocutor</option>
              <option value="coach">Coach</option>
            </select>
          </label>
          <label className="field">
            <span>Answer policy</span>
            <select value={p.answer_policy} onChange={(e) => setP({ ...p, answer_policy: e.target.value as TutorProfile["answer_policy"] })}>
              <option value="hints-first">Hints first</option>
              <option value="explain-first">Explain first</option>
            </select>
          </label>
          <label className="field">
            <span>Verbosity</span>
            <select value={p.verbosity} onChange={(e) => setP({ ...p, verbosity: e.target.value as TutorProfile["verbosity"] })}>
              <option value="terse">Terse</option>
              <option value="normal">Normal</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Notation preferences</span>
          <textarea rows={2} value={p.notation} onChange={(e) => setP({ ...p, notation: e.target.value })} />
        </label>
        {list("rules", "Custom rules", "Never write full proofs unless asked to reveal.")}
        {list("preferences", "Stated preferences", "Geometric intuition before formal proof.")}
      </div>
      <div>
        <h4 className="kicker-head">Model overrides for this subject</h4>
        {(["tutor", "fast", "deep", "vision"] as const).map((r) => (
          <label key={r} className="field">
            <span>{r}</span>
            <input type="text" value={p.model_overrides[r] ?? ""} placeholder="(settings default)" onChange={(e) => setP({ ...p, model_overrides: { ...p.model_overrides, [r]: e.target.value || undefined } })} />
          </label>
        ))}
        <label className="field">
          <span>Session-type overrides (JSON)</span>
          <textarea rows={8} className="mono" value={overrides} onChange={(e) => setOverrides(e.target.value)} spellCheck={false} />
        </label>
        {err && <ErrorState title="Not saved">{err}</ErrorState>}
        <div className="btn-row hairlines">
          <SmallCapsButton inverse onClick={save}>
            Save profile
          </SmallCapsButton>
          <a className="sc-btn" href={`/api/subjects/${subject.id}/profile/export`} download>
            Export JSON
          </a>
          <SmallCapsButton onClick={() => fileRef.current?.click()}>Import JSON</SmallCapsButton>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const raw = JSON.parse(await f.text());
                const prof = ProfilePreset.safeParse(raw).success ? ProfilePreset.parse(raw).profile : TutorProfile.parse(raw);
                setP(prof);
                setOverrides(JSON.stringify(prof.session_type_overrides, null, 2));
                useApp.getState().flash("Imported — review and save.");
              } catch (err) {
                setErr(`Not a valid profile file: ${(err as Error).message}`);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** LM-1/5: every concept and evidence entry can be viewed, edited or deleted. */
function Concepts({ subject }: { subject: Subject }) {
  const [cs, setCs] = useState<Concept[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [ev, setEv] = useState<Evidence[]>([]);
  const [name, setName] = useState("");
  const load = async () => setCs(await api.concepts(`?subjectId=${subject.id}`));
  useEffect(() => {
    void load();
  }, [subject.id]);
  useEffect(() => {
    if (open) api.evidence(open).then(setEv);
  }, [open]);
  if (!cs) return <Loading />;
  return (
    <div>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await api.addConcept({ subjectId: subject.id, name: name.trim() });
          setName("");
          await load();
        }}
      >
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a concept" aria-label="New concept" />
        <SmallCapsButton type="submit">Add</SmallCapsButton>
      </form>
      {cs.length === 0 && <Empty>No concepts yet. They arrive from accepted debriefs and practice.</Empty>}
      <table className="concepts-table">
        <thead>
          <tr>
            <th>Concept</th>
            <th>Status</th>
            <th>Latest evidence</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cs.map((c) => (
            <>
              <tr key={c.id}>
                <td>
                  <input
                    type="text"
                    defaultValue={c.name}
                    aria-label="Concept name"
                    onBlur={async (e) => e.target.value !== c.name && (await api.patchConcept(c.id, { name: e.target.value }), await load())}
                  />
                </td>
                <td>
                  <select value={c.status} aria-label="Status" onChange={async (e) => (await api.patchConcept(c.id, { status: e.target.value as Concept["status"] }), await load())}>
                    <option value="introduced">introduced</option>
                    <option value="shaky">shaky</option>
                    <option value="solid">solid</option>
                  </select>
                </td>
                <td className="evidence">{c.latestEvidence ? `${c.latestEvidence.kind}: ${c.latestEvidence.detail}` : "—"}</td>
                <td className="meta">{fmtDate(c.lastUpdated)}</td>
                <td>
                  <div className="btn-row">
                    <SmallCapsButton onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Hide" : `Evidence (${c.evidenceCount ?? 0})`}</SmallCapsButton>
                    <SmallCapsButton onClick={async () => (await api.deleteConcept(c.id), await load())}>Delete</SmallCapsButton>
                  </div>
                </td>
              </tr>
              {open === c.id && (
                <tr key={`${c.id}-ev`}>
                  <td colSpan={5}>
                    <EvidenceList conceptId={c.id} ev={ev} reload={async () => (setEv(await api.evidence(c.id)), await load())} />
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceList({ conceptId, ev, reload }: { conceptId: number; ev: Evidence[]; reload: () => Promise<void> }) {
  const [detail, setDetail] = useState("");
  return (
    <div className="evidence-list">
      {ev.map((e) => (
        <div key={e.id} className="ev-row">
          <span className="meta">
            {e.kind} · {e.polarity > 0 ? "+" : e.polarity < 0 ? "−" : "·"} · {fmtDate(e.createdAt)}
          </span>
          <input type="text" defaultValue={e.detail} aria-label="Evidence detail" onBlur={async (x) => x.target.value !== e.detail && (await api.patchEvidence(e.id, { detail: x.target.value }), await reload())} />
          <SmallCapsButton onClick={async () => (await api.deleteEvidence(e.id), await reload())}>Delete</SmallCapsButton>
        </div>
      ))}
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!detail.trim()) return;
          await api.addEvidence(conceptId, { detail: detail.trim(), kind: "user" });
          setDetail("");
          await reload();
        }}
      >
        <input type="text" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Add your own evidence" />
        <SmallCapsButton type="submit">Add</SmallCapsButton>
      </form>
    </div>
  );
}

/** WT-1..3: weekly targets with locally computed progress; week review on demand. */
function Targets({ subject }: { subject: Subject }) {
  const [row, setRow] = useState<WeekRow | null>(null);
  const [week, setWeek] = useState("");
  const [review, setReview] = useState<WeekReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    const t = await api.targets();
    setWeek(t.weekStart);
    setRow(t.subjects.find((s) => s.subject.id === subject.id) ?? null);
  };
  useEffect(() => {
    void load();
  }, [subject.id]);
  if (!row) return <Loading />;
  const target = (m: string) => row.targets.find((t) => t.metric === m)?.target ?? 0;
  return (
    <div className="desk-grid">
      <div>
        <p className="meta">Week of {week}. Progress is computed locally from your logs — no model calls.</p>
        {(["sessions", "minutes", "pages", "items"] as const).map((m) => (
          <div key={m} className="target-row">
            <label className="field">
              <span>{m === "items" ? "practice items reviewed" : m}</span>
              <input
                type="number"
                min={0}
                defaultValue={target(m) || ""}
                placeholder="no target"
                onBlur={async (e) => {
                  const v = Number(e.target.value || 0);
                  if (v !== target(m)) {
                    await api.setTarget(subject.id, m, v);
                    await load();
                  }
                }}
              />
            </label>
            <RuleBar value={row.progress[m] ?? 0} max={target(m) || Math.max(1, row.progress[m] ?? 0)} />
          </div>
        ))}
      </div>
      <div>
        <h4 className="kicker-head">Week review</h4>
        <p className="muted small">One call summarizes the week across subjects and proposes next week's targets for you to accept or edit.</p>
        <SmallCapsButton
          strong
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              setReview(await api.weekReview());
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Setting type…" : "Review my week"}
        </SmallCapsButton>
        {err && <ErrorState title="Week review failed">{err}</ErrorState>}
        {review && (
          <div className="fade-in">
            <p className="evidence">{review.summary}</p>
            {review.proposed_targets.map((t, i) => (
              <div key={i} className="ev-row">
                <span>
                  {t.subject}: {t.metric} → <strong>{t.target}</strong>
                </span>
                <SmallCapsButton
                  onClick={async () => {
                    const subs = await api.subjects();
                    const s = subs.find((x) => x.slug === t.subject || x.name.toLowerCase() === t.subject.toLowerCase());
                    if (!s) return useApp.getState().flash(`Unknown subject ${t.subject}`, "error");
                    await api.setTarget(s.id, t.metric, t.target);
                    useApp.getState().flash("Target set for this week.");
                    await load();
                  }}
                >
                  Accept
                </SmallCapsButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** SE-6: session history. */
function History({ subject }: { subject: Subject }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.sessions>> | null>(null);
  useEffect(() => {
    api.sessions(`?subjectId=${subject.id}`).then(setRows);
  }, [subject.id]);
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty>No sessions yet.</Empty>;
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Book</th>
          <th>Type</th>
          <th>Duration</th>
          <th>Pages</th>
          <th>Debrief</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id}>
            <td className="meta">{new Date(s.startedAt).toLocaleString()}</td>
            <td>{s.bookTitle}</td>
            <td>{s.type.replace("_", " ")}</td>
            <td>{s.durationMin} min</td>
            <td className="meta">{s.pages.length ? `${s.pages[0]}–${s.pages[s.pages.length - 1]}` : "—"}</td>
            <td>
              {s.debrief ? <a href={`#/report/${s.id}`}>{(s.debrief as { summary?: string }).summary?.slice(0, 80) ?? "report"}</a> : s.status === "closing" ? <a href={`#/report/${s.id}`}>write debrief</a> : <span className="muted">{s.status}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
