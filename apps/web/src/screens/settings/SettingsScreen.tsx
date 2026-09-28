import { useEffect, useState } from "react";
import type { ModelRole } from "@marginalia/shared";
import { api } from "../../api/client";
import { Loading, Masthead, SmallCapsButton, fmtTokens } from "../../components/primitives";
import { useApp } from "../../state/app";

const ROLES: ModelRole[] = ["tutor", "fast", "deep", "vision"];

/** Settings (6.2): provider, model roles, budgets, lean mode, OCR engine, appearance, data folder, export. */
export function SettingsScreen() {
  const settings = useApp((s) => s.settings);
  const save = useApp((s) => s.saveSettings);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [apiKey, setApiKey] = useState("");
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.usageWeek>>>([]);
  const [subjects, setSubjects] = useState<{ slug: string; name: string }[]>([]);

  useEffect(() => {
    void useApp.getState().loadSettings();
    api.usageWeek().then(setUsage).catch(() => {});
    api.subjects().then(setSubjects).catch(() => {});
  }, []);

  if (!settings) return <div className="page-wrap"><Masthead compact /><Loading /></div>;

  const test = async (role: ModelRole) => {
    setTests((t) => ({ ...t, [role]: "pinging…" }));
    const r = await api.testRole(role).catch((e) => ({ ok: false, error: (e as Error).message, model: "", latencyMs: 0 }) as Awaited<ReturnType<typeof api.testRole>>);
    setTests((t) => ({ ...t, [role]: r.ok ? `ok · ${r.model} · ${r.latencyMs} ms · “${r.reply}”` : `failed · ${r.model} · ${r.kind ?? ""} ${r.error ?? ""}` }));
  };

  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : d);

  return (
    <div className="page-wrap settings">
      <Masthead compact subtitle={<span className="meta">Settings</span>} />
      <div className="desk-grid">
        <section>
          <h3 className="col-head">Provider</h3>
          <div className="btn-row hairlines">
            {(
              [
                ["agent-sdk", "Claude subscription (Agent SDK)"],
                ["anthropic-api", "Claude API key"],
                ["mock", "Offline mock (testing)"],
              ] as const
            ).map(([id, label]) => (
              <label key={id} className={`sc-btn${settings.provider === id ? " strong" : ""}`}>
                <input type="radio" className="sr-only" name="provider" checked={settings.provider === id} onChange={() => save({ provider: id })} />
                {label}
              </label>
            ))}
          </div>
          {settings.provider === "agent-sdk" && (
            <p className="muted small">
              Uses your Claude Code login on this machine. Calls draw from the same plan limits as your other Claude use; switching to an API key is a settings change.
            </p>
          )}
          {settings.provider === "anthropic-api" && (
            <div className="inline-form">
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={settings.apiKeySet ? "•••••• (key saved)" : "sk-ant-…  (or leave empty to use ANTHROPIC_API_KEY)"} aria-label="API key" />
              <SmallCapsButton
                onClick={async () => {
                  await save({ apiKey });
                  setApiKey("");
                  useApp.getState().flash(apiKey ? "API key saved locally." : "API key cleared.");
                }}
              >
                {apiKey ? "Save key" : "Clear key"}
              </SmallCapsButton>
            </div>
          )}

          <h3 className="col-head">Model roles</h3>
          {ROLES.map((r) => (
            <div key={r} className="role-row">
              <label className="field">
                <span>{r}</span>
                <input type="text" defaultValue={settings.roles[r]} onBlur={(e) => e.target.value.trim() && e.target.value !== settings.roles[r] && save({ roles: { [r]: e.target.value.trim() } })} />
              </label>
              <SmallCapsButton onClick={() => test(r)}>Test</SmallCapsButton>
              <span className="meta test-out">{tests[r]}</span>
            </div>
          ))}
          <details>
            <summary className="meta">Per-subject overrides</summary>
            {subjects.map((s) => (
              <div key={s.slug} className="override-row">
                <span className="meta">{s.name}</span>
                {ROLES.map((r) => (
                  <input
                    key={r}
                    type="text"
                    placeholder={r}
                    defaultValue={settings.subjectOverrides[s.slug]?.[r] ?? ""}
                    onBlur={(e) => save({ subjectOverrides: { [s.slug]: { ...(settings.subjectOverrides[s.slug] ?? {}), [r]: e.target.value.trim() } } })}
                    aria-label={`${s.name} ${r} model`}
                  />
                ))}
              </div>
            ))}
          </details>

          <h3 className="col-head">Budgets &amp; usage</h3>
          <label className="field">
            <span>
              <input type="checkbox" checked={settings.leanMode} onChange={(e) => save({ leanMode: e.target.checked })} /> Lean mode — smaller context, templated openings, fast model for quick actions
            </span>
          </label>
          <div className="field-row">
            <label className="field">
              <span>Max input tokens / turn</span>
              <input type="number" defaultValue={settings.budgets.maxInputTokens} onBlur={(e) => save({ budgets: { maxInputTokens: num(e.target.value, 10000) } })} />
            </label>
            <label className="field">
              <span>Lean max input</span>
              <input type="number" defaultValue={settings.budgets.leanMaxInputTokens} onBlur={(e) => save({ budgets: { leanMaxInputTokens: num(e.target.value, 6000) } })} />
            </label>
            <label className="field">
              <span>Soft warning / day</span>
              <input type="number" defaultValue={settings.usageSoftWarnTokensPerDay} onBlur={(e) => save({ usageSoftWarnTokensPerDay: num(e.target.value, 400000) })} />
            </label>
          </div>
          <div className="field-row">
            {(["tutor", "notes", "debrief"] as const).map((k) => (
              <label key={k} className="field">
                <span>Max output · {k}</span>
                <input type="number" defaultValue={settings.budgets.maxOutputTokens[k]} onBlur={(e) => save({ budgets: { maxOutputTokens: { [k]: num(e.target.value, settings.budgets.maxOutputTokens[k]) } } })} />
              </label>
            ))}
          </div>
          <h4 className="kicker-head">Usage, last 7 days by role</h4>
          {usage.length === 0 ? (
            <p className="muted small">No model calls yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Purpose</th>
                  <th>Model</th>
                  <th>Calls</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Fail</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u, i) => (
                  <tr key={i}>
                    <td>{u.role}</td>
                    <td>{u.purpose}</td>
                    <td className="meta">{u.model}</td>
                    <td>{u.calls}</td>
                    <td>{fmtTokens(u.inTokens)}</td>
                    <td>{fmtTokens(u.outTokens)}</td>
                    <td>{u.failures}</td>
                    <td>{u.avgLatencyMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h3 className="col-head">Text extraction</h3>
          <label className="field">
            <span>Default OCR engine for scanned pages</span>
            <select value={settings.ocrEngine} onChange={(e) => save({ ocrEngine: e.target.value as "local" | "vision" })}>
              <option value="vision">Vision model (per page on first visit, cached)</option>
              <option value="local">Local OCR — ocrmypdf + Tesseract {settings.ocrmypdf ? "(installed)" : "(not installed)"}</option>
            </select>
          </label>

          <h3 className="col-head">Appearance</h3>
          <div className="btn-row hairlines">
            {(["print", "inverted"] as const).map((t) => (
              <label key={t} className={`sc-btn${settings.appearance.theme === t ? " strong" : ""}`}>
                <input type="radio" className="sr-only" name="theme" checked={settings.appearance.theme === t} onChange={() => save({ appearance: { theme: t } })} />
                {t === "print" ? "Print (light)" : "Inverted print (dark)"}
              </label>
            ))}
          </div>
          <label className="field">
            <span>Font size · {settings.appearance.fontSize}px</span>
            <input type="range" min={12} max={24} value={settings.appearance.fontSize} onChange={(e) => save({ appearance: { fontSize: Number(e.target.value) } })} />
          </label>
          <label className="field">
            <span>Reading width · {settings.appearance.readingWidth}px</span>
            <input type="range" min={480} max={1400} step={20} value={settings.appearance.readingWidth} onChange={(e) => save({ appearance: { readingWidth: Number(e.target.value) } })} />
          </label>
          <label className="field">
            <span>
              <input type="checkbox" checked={settings.autoLayoutBySessionType} onChange={(e) => save({ autoLayoutBySessionType: e.target.checked })} /> Switch layout preset by session type
            </span>
          </label>

          <h3 className="col-head">Data</h3>
          <p className="small">
            Everything lives in one SQLite file plus your PDFs:
            <br />
            <code>{settings.dataDir}</code>
          </p>
          <SmallCapsButton
            strong
            onClick={async () => {
              const r = await api.exportNotes();
              useApp.getState().flash(`Exported ${r.files.length} notes to ${r.dir}`);
            }}
          >
            Export all notes to Markdown
          </SmallCapsButton>
          <h3 className="col-head">Claude Code (MCP)</h3>
          <p className="small">Register the study-data server with Claude Code:</p>
          <pre className="wrap">{settings.mcpCommand}</pre>
        </section>
      </div>
    </div>
  );
}
