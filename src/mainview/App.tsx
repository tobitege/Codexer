import { Electroview } from "electrobun/view";
import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import type {
  FindCodexSessionsResult,
  SessionMetaMatch,
} from "../shared/codex-core.ts";
import type { CodexerRPC } from "../shared/rpc.ts";

type BrowseMode = "all" | "folder";

type AppliedQuery = {
  browseMode: BrowseMode;
  targetDirectory: string | null;
  cwdOnly: boolean;
};

type ExportState = {
  kind: "idle" | "working" | "success" | "error";
  message: string;
  outputPath: string | null;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const rpc = Electroview.defineRPC<CodexerRPC>({
  handlers: {
    requests: {},
    messages: {},
  },
});

const electroview = new Electroview({ rpc });

function App() {
  const [result, setResult] = useState<FindCodexSessionsResult | null>(null);
  const [codexHome, setCodexHome] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [cwdOnly, setCwdOnly] = useState(false);
  const [appliedQuery, setAppliedQuery] = useState<AppliedQuery>({
    browseMode: "folder",
    targetDirectory: "",
    cwdOnly: false,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState>({
    kind: "idle",
    message: "",
    outputPath: null,
  });
  const [exportImages, setExportImages] = useState(false);
  const [exportToolCallResults, setExportToolCallResults] = useState(false);
  const codexHomeRef = useRef(codexHome);
  const folderPathRef = useRef(folderPath);
  const loadRequestIdRef = useRef(0);

  const deferredSearchQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    void loadSessions("", "folder");
  }, []);

  useEffect(() => {
    codexHomeRef.current = codexHome;
  }, [codexHome]);

  useEffect(() => {
    folderPathRef.current = folderPath;
  }, [folderPath]);

  const filteredSessions = (result?.sessions ?? []).filter((session) =>
    matchesSearch(session, deferredSearchQuery),
  );
  const activeSession =
    filteredSessions.find((session) => session.file === selectedFile) ??
    filteredSessions[0] ??
    null;

  useEffect(() => {
    const hasSelectedSession = filteredSessions.some(
      (session) => session.file === selectedFile,
    );
    const nextSelection = filteredSessions[0]?.file ?? null;
    if (!hasSelectedSession && nextSelection !== selectedFile) {
      startTransition(() => {
        setSelectedFile(nextSelection);
      });
    }
  }, [filteredSessions, selectedFile]);

  async function loadSessions(
    targetDirectory: string | null,
    nextBrowseMode: BrowseMode,
    nextCwdOnly = cwdOnly,
  ): Promise<void> {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);

    try {
      const nextResult = await getRpc().request.loadSessions({
        codexHome: codexHome.trim() || null,
        targetDirectory,
        cwdOnly: nextCwdOnly,
      });

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setResult(nextResult);
      setAppliedQuery({
        browseMode: nextBrowseMode,
        targetDirectory,
        cwdOnly: nextCwdOnly,
      });
      if (!codexHomeRef.current.trim()) {
        setCodexHome(nextResult.codexHome);
      }
      if (!folderPathRef.current.trim()) {
        setFolderPath(nextResult.currentWorkingDirectory);
      }
      if (targetDirectory !== null && nextResult.requestedDirectory) {
        setFolderPath(nextResult.requestedDirectory);
      }
      setSelectedFile((current) =>
        current && nextResult.sessions.some((session) => session.file === current)
          ? current
          : nextResult.sessions[0]?.file ?? null,
      );
    } catch (loadError) {
      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setError(asErrorMessage(loadError));
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function pickFolder(): Promise<void> {
    try {
      const { path } = await getRpc().request.pickDirectory({
        startingFolder: folderPath.trim() || null,
      });

      if (!path) {
        return;
      }

      setFolderPath(path);
      void loadSessions(path, "folder", cwdOnly);
    } catch (pickError) {
      setError(asErrorMessage(pickError));
    }
  }

  async function exportActiveSessionMarkdown(): Promise<void> {
    if (!activeSession) {
      return;
    }

    setExportState({
      kind: "working",
      message: "Creating Markdown export...",
      outputPath: null,
    });

    try {
      const { outputPath } = await getRpc().request.exportSessionMarkdown({
        sessionFilePath: activeSession.file,
        includeImages: exportImages,
        includeToolCallResults: exportToolCallResults,
      });

      setExportState({
        kind: "success",
        message: `Markdown written to ${outputPath}`,
        outputPath,
      });
    } catch (exportError) {
      setExportState({
        kind: "error",
        message: asErrorMessage(exportError),
        outputPath: null,
      });
    }
  }

  async function revealPath(targetPath: string | null): Promise<void> {
    if (!targetPath) {
      return;
    }

    try {
      await getRpc().request.revealPath({ path: targetPath });
    } catch (revealError) {
      setError(asErrorMessage(revealError));
    }
  }

  async function openPath(targetPath: string | null): Promise<void> {
    if (!targetPath) {
      return;
    }

    try {
      const response = await getRpc().request.openPath({ path: targetPath });
      if (!response.ok) {
        setError(`Could not open ${targetPath}`);
      }
    } catch (openError) {
      setError(asErrorMessage(openError));
    }
  }

  function handleLoadAll(): void {
    void loadSessions(null, "all", cwdOnly);
  }

  function handleFilterByFolder(): void {
    void loadSessions(getRequestedFolderTarget(folderPath), "folder", cwdOnly);
  }

  function handleRefresh(): void {
    void loadSessions(
      appliedQuery.targetDirectory,
      appliedQuery.browseMode,
      appliedQuery.cwdOnly,
    );
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className="workspace">
        <header className="hero">
          <div>
            <p className="eyebrow">Electrobun session browser</p>
            <h1>codexer</h1>
            <p className="hero-copy">
              Browse Codex sessions, filter to a repo or folder, and export any
              session JSONL as Markdown.
            </p>
          </div>
          <div className="hero-stats">
            <div className="stat-card">
              <span className="stat-label">Loaded</span>
              <strong>{result?.sessionCount ?? 0}</strong>
              <span>{result ? `${result.liveCount} live / ${result.archivedCount} archived` : "Waiting for scan"}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Scope</span>
              <strong>{describeScope(result, appliedQuery.browseMode)}</strong>
              <span
                className="stat-detail"
                title={result?.targetRoot ?? "All Codex sessions"}
              >
                {result?.targetRoot ?? "All Codex sessions"}
              </span>
            </div>
          </div>
        </header>

        <section className="control-strip">
          <div className="value-field">
            <span>Codex home</span>
            <div className="value-chip mono">{codexHome || "Loading..."}</div>
          </div>
          <button className="ghost-button" onClick={handleRefresh}>
            Refresh
          </button>

          <label className="field field-wide">
            <span>Folder filter</span>
            <input
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleFilterByFolder();
                }
              }}
              placeholder="Optional repo or folder"
            />
          </label>
          <button className="ghost-button" onClick={() => void pickFolder()}>
            Choose folder…
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={cwdOnly}
              onChange={(event) => setCwdOnly(event.target.checked)}
            />
            <span>Match only this folder tree</span>
          </label>
          <button className="ghost-button" onClick={handleLoadAll}>
            All sessions
          </button>
          <button className="primary-button" onClick={handleFilterByFolder}>
            Filter by folder
          </button>
        </section>

        <section className="content-grid">
          <aside className="panel session-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Session index</p>
                <h2>Recent matches</h2>
              </div>
              <label className="field compact-field">
                <span>Search</span>
                <input
                  value={searchQuery}
                  onChange={(event) => {
                    startTransition(() => {
                      setSearchQuery(event.target.value);
                    });
                  }}
                  placeholder="Thread, cwd, file, id"
                />
              </label>
            </div>

            <div className="results-meta">
              <span>{filteredSessions.length} visible</span>
              <span>{loading ? "Scanning…" : "Sorted newest first"}</span>
            </div>

            {loading ? (
              <div className="empty-state">Scanning Codex session metadata…</div>
            ) : filteredSessions.length === 0 ? (
              <div className="empty-state">
                {error ?? "No sessions match the current filter."}
              </div>
            ) : (
              <div className="session-list">
                {filteredSessions.map((session) => (
                  <button
                    key={session.file}
                    className={session.file === activeSession?.file ? "session-card selected" : "session-card"}
                    onClick={() => setSelectedFile(session.file)}
                  >
                    <div className="session-card-top">
                      <span className={`kind-pill kind-${session.kind}`}>{session.kind}</span>
                      <span>{formatTimestamp(session.updatedAt ?? session.startedAt)}</span>
                    </div>
                    <strong>{getSessionTitle(session)}</strong>
                    <span className="session-path">{session.cwd}</span>
                    <span className="session-file">{session.file}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          <section className="panel detail-panel">
            {activeSession ? (
              <>
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Selected session</p>
                    <h2>{getSessionTitle(activeSession)}</h2>
                  </div>
                  <div className="detail-actions">
                    <button className="ghost-button" onClick={() => void revealPath(activeSession.file)}>
                      Reveal JSONL
                    </button>
                    <button className="primary-button" onClick={() => void exportActiveSessionMarkdown()}>
                      Export .md
                    </button>
                  </div>
                </div>

                <dl className="meta-grid">
                  <MetaRow label="Updated" value={formatTimestamp(activeSession.updatedAt)} />
                  <MetaRow label="Started" value={formatTimestamp(activeSession.startedAt)} />
                  <MetaRow label="Kind" value={activeSession.kind} />
                  <MetaRow label="Session ID" value={activeSession.id} mono />
                  <MetaRow label="CWD" value={activeSession.cwd} mono />
                  <MetaRow label="JSONL file" value={activeSession.file} mono />
                </dl>

                <section className="note-card">
                  <h3>Markdown export</h3>
                  <p>
                    The export lands right beside the JSONL file and keeps the same
                    basename, so <code>.jsonl</code> becomes <code>.md</code>. If image
                    export is enabled, screenshots are written into a sibling
                    <code>.assets</code> folder and linked from the Markdown.
                  </p>
                  <div className="export-options">
                    <label className="toggle export-toggle">
                      <input
                        type="checkbox"
                        checked={exportImages}
                        onChange={(event) => setExportImages(event.target.checked)}
                      />
                      <span>Include images</span>
                    </label>
                    <label className="toggle export-toggle">
                      <input
                        type="checkbox"
                        checked={exportToolCallResults}
                        onChange={(event) => setExportToolCallResults(event.target.checked)}
                      />
                      <span>Include tool calls and results</span>
                    </label>
                  </div>
                </section>

                <section className={`status-card status-${exportState.kind}`}>
                  <div>
                    <p className="eyebrow">Export status</p>
                    <strong>
                      {exportState.kind === "idle"
                        ? "Ready"
                        : exportState.kind === "working"
                          ? "Working"
                          : exportState.kind === "success"
                            ? "Complete"
                            : "Needs attention"}
                    </strong>
                    <p>{exportState.message || "Pick any session and create a Markdown transcript export."}</p>
                  </div>
                  <div className="detail-actions">
                    <button
                      className="ghost-button"
                      disabled={!exportState.outputPath}
                      onClick={() => void revealPath(exportState.outputPath)}
                    >
                      Reveal Markdown
                    </button>
                    <button
                      className="ghost-button"
                      disabled={!exportState.outputPath}
                      onClick={() => void openPath(exportState.outputPath)}
                    >
                      Open Markdown
                    </button>
                  </div>
                </section>

                {error ? <div className="inline-error">{error}</div> : null}
              </>
            ) : (
              <div className="empty-state detail-empty">
                {error ?? "Select a session to inspect it and export a Markdown transcript."}
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="meta-row">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </div>
  );
}

function describeScope(
  result: FindCodexSessionsResult | null,
  browseMode: BrowseMode,
): string {
  if (!result) {
    return "Loading";
  }

  if (browseMode === "all" || result.scopeMode === "all") {
    return "All sessions";
  }

  return result.scopeMode === "repo" ? "Repo root" : "Folder tree";
}

function getSessionTitle(session: SessionMetaMatch): string {
  const threadName = session.threadName?.trim();
  if (threadName) {
    return threadName;
  }

  return basename(session.file).replace(/\.jsonl$/i, "");
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : timestampFormatter.format(parsed);
}

function matchesSearch(session: SessionMetaMatch, query: string): boolean {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return true;
  }

  return [
    session.threadName ?? "",
    session.cwd,
    session.file,
    session.id,
    session.kind,
  ].some((field) => field.toLowerCase().includes(trimmedQuery));
}

function asErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function getRequestedFolderTarget(folderPath: string): string {
  return folderPath.trim() || "";
}

function getRpc() {
  if (!electroview.rpc) {
    throw new Error("Electroview RPC is not available.");
  }

  return electroview.rpc;
}

export default App;
