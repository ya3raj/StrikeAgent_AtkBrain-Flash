import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, formatApiError } from "../api";
import type { Project } from "../types";
import { Modal } from "../components/Modal";
import { ImportProgressBar, isImportPaused, isImportRunning, type ImportProgress } from "../components/ImportProgressBar";
import { fadeInUp } from "../anim";
import { PaginationBar, pageItems, readPageSize } from "../components/PaginationBar";
import { colors } from "../theme";
import { listStatusOf } from "../projectStatus";
import { useT } from "../i18n";
import { getLocale, type Locale } from "../i18n/locale";

function trackOf(p: Project): "redteam" | "ctf" | "src" {
  const tr = (p.config as any)?.track;
  const obj = (p.config as any)?.objective;
  if (tr === "src" || obj === "src") return "src";
  if (tr === "ctf") return "ctf";
  if (p.kind === "benchmark") return "ctf";
  if (obj === "flag") return "ctf";
  return "redteam";
}

type BatchAction = "start" | "stop" | "delete";
function statusOf(p: Project) { return listStatusOf(p); }

const STATUS_KEYS = ["all", "running", "completed", "idle", "stopped", "error"] as const;

export function ProjectsPage() {
  const { t } = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""); const [kind, setKind] = useState("all"); const [track, setTrack] = useState("all"); const [status, setStatus] = useState("all");
  const [pendingAction, setPendingAction] = useState<BatchAction | null>(null);
  const [batchErr, setBatchErr] = useState("");
  const [rename, setRename] = useState<Project | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [params, setParams] = useSearchParams();
  const heroRef = useRef<HTMLDivElement>(null);
  const load = () => api.listProjects().then(setProjects).catch(() => {});
  useEffect(() => { load(); const tmr = setInterval(load, 15000); return () => clearInterval(tmr); }, []);
  useEffect(() => { if (heroRef.current) fadeInUp(heroRef.current.children); }, []);
  useEffect(() => { if (params.get("create") === "1") { setShowCreate(true); setParams({}, { replace: true }); } }, [params, setParams]);
  useEffect(() => { const alive = new Set(projects.map((p) => p.id)); setSelected((old) => new Set([...old].filter((id) => alive.has(id)))); }, [projects]);
  const visible = projects.filter((p) => (!query || `${p.name} ${p.target || ""}`.toLowerCase().includes(query.toLowerCase())) && (kind === "all" || (kind === "single" ? p.kind === "single" : p.kind !== "single")) && (track === "all" || trackOf(p) === track) && (status === "all" || statusOf(p) === status));
  useEffect(() => { setPage(1); }, [query, kind, track, status]);
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize) || 1);
  const curPage = Math.min(page, pageCount);
  const paged = pageItems(visible, curPage, pageSize);
  const toggle = (id: string) => setSelected((old) => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const selectAll = () => setSelected(new Set(visible.map((p) => p.id)));
  const pageAllSelected = paged.length > 0 && paged.every((p) => selected.has(p.id));
  const togglePage = () => {
    if (pageAllSelected) {
      const drop = new Set(paged.map((p) => p.id));
      setSelected((old) => new Set([...old].filter((id) => !drop.has(id))));
    } else {
      setSelected((old) => new Set([...old, ...paged.map((p) => p.id)]));
    }
  };
  const runBatch = async () => {
    const ids = [...selected]; if (!pendingAction || !ids.length) return;
    setBusy(true);
    setBatchErr("");
    try {
      let result: { failed?: { id?: string; error?: string }[] } | undefined;
      if (pendingAction === "delete") await api.batchDeleteProjects(ids);
      if (pendingAction === "start") result = await api.batchStartProjects(ids);
      if (pendingAction === "stop") result = await api.batchStopProjects(ids);
      const failed = result?.failed || [];
      if (failed.length) {
        setBatchErr(failed.map((f) => `${f.id || ""} ${f.error || ""}`.trim()).join("；"));
      }
      setSelected(new Set());
      await load();
    } catch (e: any) {
      setBatchErr(formatApiError(e, t("projects.batchFailed")));
    } finally {
      setBusy(false);
      setPendingAction(null);
    }
  };
  const statusFilterLabel = (key: string) => ({
    all: t("projects.statusAll"),
    running: t("projects.statusRunning"),
    completed: t("projects.statusCompleted"),
    idle: t("projects.statusIdle"),
    stopped: t("projects.statusStopped"),
    error: t("projects.statusError"),
  } as Record<string, string>)[key] || key;
  return <div className="page-container projects-page">
    <div ref={heroRef} className="spread" style={{ alignItems: "flex-end", marginBottom: 26 }}><div><p className="eyebrow">PROJECTS</p><h1>{t("projects.title")}</h1><p className="muted" style={{ marginTop: 8 }}>{t("projects.subtitle")}</p></div><button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ {t("shell.newProject")}</button></div>
    <section className="project-list-toolbar"><input className="input project-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("projects.search")} /><Filter value={kind} onChange={setKind} options={[["all", t("projects.kindAll")], ["single", t("projects.kindSingle")], ["cluster", t("projects.kindCluster")]]} /><Filter value={track} onChange={setTrack} options={[["all", t("projects.trackAll")], ["ctf", "CTF"], ["redteam", t("projects.trackRed")], ["src", t("projects.trackSrc")]]} /></section>
    <div className="status-filters">{STATUS_KEYS.map((key) => <button key={key} className={status === key ? "active" : ""} onClick={() => setStatus(key)}>{statusFilterLabel(key)} <b>{key === "all" ? projects.length : projects.filter((p) => statusOf(p) === key).length}</b></button>)}</div>
    <div className="batch-toolbar"><span className="muted">{t("projects.selected", { n: selected.size, total: visible.length })}</span><button className="btn btn-secondary btn-sm" onClick={selectAll} disabled={!visible.length || busy}>{t("projects.selectFiltered")}</button><button className="btn btn-secondary btn-sm" onClick={() => setSelected(new Set())} disabled={!selected.size || busy}>{t("projects.clearSelect")}</button><div style={{ flex: 1 }} /><button className="btn btn-primary btn-sm" onClick={() => setPendingAction("start")} disabled={!selected.size || busy}>{t("projects.batchStart")}</button><button className="btn btn-secondary btn-sm" onClick={() => setPendingAction("stop")} disabled={!selected.size || busy}>{t("projects.batchStop")}</button><button className="btn btn-danger btn-sm" onClick={() => setPendingAction("delete")} disabled={!selected.size || busy}>{t("projects.batchDelete")}</button></div>
    {batchErr ? <p className="error-text" style={{ margin: "8px 0 0" }}>{batchErr}</p> : null}
    <div className="project-table-wrap"><table className="project-table"><thead><tr><th><input type="checkbox" checked={pageAllSelected} onChange={togglePage} /></th><th>{t("projects.colName")}</th><th>{t("projects.colKind")}</th><th>{t("projects.colStatus")}</th><th>{t("projects.colNodes")}</th><th>{t("projects.colServices")}</th><th>{t("projects.colHigh")}</th><th>{t("projects.colCritical")}</th><th>{t("projects.colUpdated")}</th></tr></thead><tbody>{paged.map((p) => <ProjectRow key={p.id} p={p} selected={selected.has(p.id)} onToggle={() => toggle(p.id)} onRename={() => setRename(p)} />)}</tbody></table>{!visible.length && <div className="empty-list">{t("projects.empty")}</div>}</div>
    {visible.length > 0 && <PaginationBar total={visible.length} page={curPage} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />}
    {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreated={load} />}
    {rename && <RenameDialog project={rename} onClose={() => setRename(null)} onSaved={() => { setRename(null); load(); }} />}
    {pendingAction && <BatchConfirm action={pendingAction} count={selected.size} projects={projects.filter((p) => selected.has(p.id))} onClose={() => setPendingAction(null)} onConfirm={runBatch} busy={busy} />}
  </div>;
}

function Filter({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) { return <select className="select compact-filter" value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>; }
function ProjectRow({ p, selected, onToggle, onRename }: { p: Project; selected: boolean; onToggle: () => void; onRename: () => void }) {
  const { t } = useT();
  const nav = useNavigate(); const s: any = p.stats || {}; const color: Record<string, string> = { running: colors.success, completed: colors.primary, idle: colors.mutedSoft, error: colors.error, stopped: colors.muted };
  const track = trackOf(p);
  const trackText = track === "redteam" ? t("projects.trackRed") : track === "ctf" ? "CTF" : t("projects.trackSrc");
  const kindText = p.kind === "single" ? t("projects.single") : p.kind === "benchmark" ? (track === "src" ? t("projects.srcCluster") : t("projects.ctfCluster")) : t("projects.cluster");
  const subText = p.target || (p.kind === "benchmark" ? (track === "src" ? t("projects.srcGlue") : t("projects.ctfBench")) : t("projects.multiAsset"));
  const listStatus = statusOf(p);
  const listStatusText = ({
    all: t("projects.statusAll"),
    running: t("projects.statusRunning"),
    completed: t("projects.statusCompleted"),
    idle: t("projects.statusIdle"),
    stopped: t("projects.statusStopped"),
    error: t("projects.statusError"),
    queued: t("status.queued"),
  } as Record<string, string>)[listStatus] || listStatus;
  return <tr className={selected ? "selected" : ""} onClick={() => nav(`/project/${p.id}`)}><td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected} onChange={onToggle} /></td><td><strong>{p.name}</strong><span className="table-sub mono">{subText}</span></td><td><span className="badge badge-pill">{kindText}</span><span className="table-sub">{trackText}</span></td><td><span className="row" style={{ gap: 6 }}><span className="pulse-dot" style={{ background: color[listStatus] || colors.muted }} />{listStatusText}</span></td><td>{s.nodes || 0}</td><td>{s.services || 0}</td><td>{s.high || 0}</td><td className={s.critical ? "danger-number" : ""}>{s.critical || 0}</td><td><span className="table-sub">{new Date((p.updated_at || p.created_at) * 1000).toLocaleString()}</span><button className="row-rename" onClick={(e) => { e.stopPropagation(); onRename(); }}>{t("common.edit")}</button></td></tr>;
}
function BatchConfirm({ action, count, projects, onClose, onConfirm, busy }: { action: BatchAction; count: number; projects: Project[]; onClose: () => void; onConfirm: () => void; busy: boolean }) {
  const { t } = useT();
  const label = { start: t("common.start"), stop: t("common.pause"), delete: t("common.delete") }[action]; const running = projects.filter((p) => statusOf(p) === "running" || statusOf(p) === "queued").length;
  return <Modal title={t("projects.confirmBatch", { action: label })} onClose={onClose}><p>{t("projects.confirmBatchBody", { n: count, action: label })}</p><div className="confirm-impact">{t("projects.confirmImpact", { running, clusters: projects.filter((p) => p.kind !== "single").length })}</div><p className="muted">{action === "delete" ? t("projects.deleteWarn") : action === "stop" ? t("projects.stopWarn") : t("projects.startWarn")}</p><div className="row" style={{ justifyContent: "flex-end", marginTop: 22 }}><button className="btn btn-secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</button><button className={`btn ${action === "delete" ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy}>{busy ? t("common.processing") : t("projects.confirmAction", { action: label })}</button></div></Modal>;
}
function RenameDialog({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const [name, setName] = useState(project.name); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const save = async () => { if (!name.trim()) return setErr(t("projects.nameRequired")); setBusy(true); try { await api.renameProject(project.id, name.trim()); onSaved(); } catch (e: any) { setErr(e?.message || t("projects.renameFailed")); } finally { setBusy(false); } };
  return <Modal title={t("projects.renameTitle")} onClose={onClose}><p className="muted">{project.kind === "single" ? t("projects.renameSingle") : t("projects.renameCluster")}</p><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />{err && <p className="error-text">{err}</p>}<div className="row" style={{ justifyContent: "flex-end", marginTop: 20 }}><button className="btn btn-secondary" onClick={onClose}>{t("common.cancel")}</button><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t("common.saving") : t("projects.saveName")}</button></div></Modal>;
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t, locale } = useT();
  const nav = useNavigate();
  const [kind, setKind] = useState<"single" | "cluster">("single");
  const [track, setTrack] = useState<"redteam" | "ctf" | "src">("redteam");
  const [outputLang, setOutputLang] = useState<Locale>(() => getLocale());
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [ports, setPorts] = useState("");
  const [assets, setAssets] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://tsecbench.zc.tencent.com");
  const [token, setToken] = useState("");
  const [authUser, setAuthUser] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importKick, setImportKick] = useState(0);
  const [hardStops, setHardStops] = useState<Record<string, { label?: string; conditions?: string[] }>>({});
  const importPoll = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setOutputLang(locale); }, [locale]);

  useEffect(() => {
    api.settings().then((s) => setHardStops(s?.defaults?.hard_stop || {})).catch(() => {});
  }, [locale]);

  const enterProject = (id: string) => {
    if (importPoll.current) clearTimeout(importPoll.current);
    onCreated();
    onClose();
    nav(`/project/${id}`);
  };

  useEffect(() => {
    if (!createdId) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const p = await api.importProgress(createdId) as ImportProgress;
        if (stop) return;
        setImportProgress(p);
        if (isImportRunning(p)) {
          importPoll.current = setTimeout(tick, 400);
        } else if (p.phase === "error") {
          setErr(p.message || t("projects.importFailed"));
        } else if (isImportPaused(p)) {
          setBusy(false);
        } else if (p.phase === "done") {
          enterProject(createdId);
        }
      } catch {
        if (!stop) importPoll.current = setTimeout(tick, 1200);
      }
    };
    tick();
    return () => {
      stop = true;
      if (importPoll.current) clearTimeout(importPoll.current);
    };
  }, [createdId, importKick]);

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const clusterBenchmark = kind === "cluster" && track === "ctf";
      const body: any = { kind: clusterBenchmark ? "benchmark" : kind, name, track, output_lang: outputLang };
      if (kind === "single") {
        body.target = target.trim();
        if (!body.target) throw new Error(t("projects.needTarget"));
        if (ports.trim()) body.ports = ports.split(/[,\s]+/).filter(Boolean).map(Number);
        body.allow_subdomains = false;
      } else if (clusterBenchmark) {
        if (!baseUrl.trim() || !token.trim()) throw new Error(t("projects.needBench"));
        body.base_url = baseUrl.trim();
        body.token = token.trim();
      } else {
        const lines = assets.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (!lines.length) throw new Error(t("projects.needAssets"));
        body.assets = [assets];
        setImportProgress({
          phase: "merge",
          done: 0,
          total: lines.length,
          message: track === "src" ? t("projects.mergingZone") : t("projects.mergingHost"),
        });
      }
      if (track !== "ctf") {
        if (authUser.trim()) body.auth_user = authUser.trim();
        if (authPassword) body.auth_password = authPassword;
        if (authToken.trim()) body.auth_token = authToken.trim();
      }
      const p: any = await api.createProject(body);
      if (kind === "cluster" && !clusterBenchmark && (p.importing || p.import_progress)) {
        setCreatedId(p.id);
        setImportProgress(p.import_progress || { phase: "spawn", done: 0, total: 0, message: t("projects.importing") });
        return;
      }
      onCreated();
      onClose();
      nav(`/project/${p.id}`);
    } catch (e: any) {
      setErr(e.message || t("projects.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    if (createdId) onCreated();
    onClose();
  };

  return (
    <Modal title={t("projects.createTitle")} onClose={handleClose}>
      <div className="field">
        <span>{t("projects.shape")}</span>
        <div className="row" style={{ gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button className={`btn ${kind === "single" ? "btn-primary" : "btn-secondary"}`} onClick={() => setKind("single")}>{t("projects.singleTarget")}</button>
          <button className={`btn ${kind === "cluster" ? "btn-primary" : "btn-secondary"}`} onClick={() => setKind("cluster")}>{t("projects.clusterAssets")}</button>
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <span>{t("projects.track")}</span>
        <div className="row" style={{ gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button type="button" className={`btn btn-sm ${track === "redteam" ? "btn-primary" : "btn-secondary"}`} onClick={() => setTrack("redteam")}>{t("projects.trackRedBtn")}</button>
          <button type="button" className={`btn btn-sm ${track === "ctf" ? "btn-primary" : "btn-secondary"}`} onClick={() => setTrack("ctf")}>{t("projects.trackCtfBtn")}</button>
          <button type="button" className={`btn btn-sm ${track === "src" ? "btn-primary" : "btn-secondary"}`} onClick={() => setTrack("src")}>{t("projects.trackSrcBtn")}</button>
        </div>
        <span style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, display: "block", lineHeight: 1.55 }}>
          {track === "redteam" && t("projects.hintRed")}
          {track === "ctf" && (kind === "cluster" ? t("projects.hintCtfCluster") : t("projects.hintCtfSingle"))}
          {track === "src" && (kind === "cluster" ? t("projects.hintSrcCluster") : t("projects.hintSrcSingle"))}
          {" "}
          {(track === "ctf" ? hardStops.flag : hardStops[track])?.label || ""}
          {((track === "ctf" ? hardStops.flag : hardStops[track])?.conditions || []).map((c) => (
            <div key={c}>· {c}</div>
          ))}
        </span>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <span>{t("common.outputLang")}</span>
        <div className="row" style={{ gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button type="button" className={`btn btn-sm ${outputLang === "zh" ? "btn-primary" : "btn-secondary"}`} onClick={() => setOutputLang("zh")}>{t("common.langZh")}</button>
          <button type="button" className={`btn btn-sm ${outputLang === "en" ? "btn-primary" : "btn-secondary"}`} onClick={() => setOutputLang("en")}>{t("common.langEn")}</button>
        </div>
        <span style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, display: "block", lineHeight: 1.55 }}>
          {t("common.outputLangHint")}
        </span>
      </div>

      <label className="field" style={{ marginTop: 12 }}>
        <span>{t("projects.name")}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "single" ? t("projects.namePhSingle") : t("projects.namePhCluster")} />
      </label>

      {kind === "single" && (
        <>
          <label className="field">
            <span>{t("projects.target")}</span>
            <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="192.168.236.1:8787 or example.com" />
          </label>
          <label className="field">
            <span>{t("projects.ports")}</span>
            <input className="input" value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="80,443,8787" />
          </label>
          <span style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, display: "block" }}>
            {t("projects.scopeHint")}
          </span>
        </>
      )}

      {kind === "cluster" && track !== "ctf" && (
        <div className="field">
          <span>{t("projects.assets")}</span>
          <div className="row" style={{ gap: 10, margin: "6px 0 8px", flexWrap: "wrap", alignItems: "center" }}>
            <label className="btn btn-secondary btn-sm" style={{ cursor: "pointer" }}>
              {t("projects.pickFile")}
              <input
                type="file"
                accept=".txt,.csv,.list,text/plain"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const text = await f.text();
                  setAssets((prev) => (prev ? `${prev.trim()}\n${text}` : text));
                }}
              />
            </label>
            <span className="muted" style={{ fontSize: 12 }}>
              {track === "src" ? t("projects.mergeSrc") : t("projects.mergeRed")}
            </span>
          </div>
          <textarea
            className="input"
            rows={5}
            value={assets}
            onChange={(e) => setAssets(e.target.value)}
            placeholder={"10.0.0.5\nexample.com\n10.0.0.6:8080"}
          />
          <span style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, display: "block" }}>
            {t("projects.mergeHint")}{track === "src" ? t("projects.mergeHintSrc") : ""}.
          </span>
        </div>
      )}

      {kind === "cluster" && track === "ctf" && (
        <>
          <label className="field">
            <span>{t("projects.benchUrl")}</span>
            <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://tsecbench.zc.tencent.com" />
          </label>
          <label className="field">
            <span>{t("projects.benchToken")}</span>
            <input className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="a1b2c3d4-..." />
          </label>
          <span style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, display: "block" }}>
            {t("projects.benchHint")}
          </span>
        </>
      )}

      {track !== "ctf" && (
        <div className="field" style={{ marginTop: 12 }}>
          <span>{t("projects.authTitle")}</span>
          <label className="field" style={{ marginTop: 8 }}>
            <span>{t("projects.authUser")}</span>
            <input className="input" autoComplete="off" value={authUser} onChange={(e) => setAuthUser(e.target.value)} placeholder="admin" />
          </label>
          <label className="field">
            <span>{t("projects.authPassword")}</span>
            <input className="input" type="password" autoComplete="new-password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("projects.authToken")}</span>
            <input className="input" autoComplete="off" value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="Bearer eyJ... or Cookie: session=..." />
          </label>
          <span style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, display: "block", lineHeight: 1.55 }}>
            {t("projects.authHint")}
          </span>
        </div>
      )}

      {err && <div style={{ color: "var(--error)", marginBottom: 12, fontSize: 14 }}>{err}</div>}
      {(busy || importProgress) && kind === "cluster" && track !== "ctf" && (
        <ImportProgressBar
          progress={importProgress || { phase: "spawn", done: 0, total: 0, message: t("projects.creatingCluster") }}
          onPause={createdId ? async () => {
            try {
              const p = await api.pauseImport(createdId);
              setImportProgress(p);
            } catch (e: any) {
              setErr(e.message || t("projects.pauseImportFailed"));
            }
          } : undefined}
          onResume={createdId ? async () => {
            try {
              const r = await api.resumeImport(createdId);
              setImportProgress(r.import_progress || r);
              setBusy(true);
              setImportKick((n) => n + 1);
            } catch (e: any) {
              setErr(e.message || t("projects.resumeImportFailed"));
            }
          } : undefined}
        />
      )}
      <div className="row" style={{ justifyContent: "flex-end", gap: 10 }}>
        <button className="btn btn-secondary" onClick={handleClose} disabled={busy}>{t("common.cancel")}</button>
        {createdId ? (
          <button className="btn btn-primary" onClick={() => enterProject(createdId)}>{t("projects.enterProject")}</button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? t("projects.importingBtn") : t("projects.createEnter")}
          </button>
        )}
      </div>
    </Modal>
  );
}
