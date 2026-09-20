/**
 * Authored vs rendered config for one node.
 *
 * WHY both panes side by side: the rendered artifact is the plane's own
 * output, and comparing it against what the admin pasted is how a skipped
 * or malformed render becomes visible at a glance. The rendered pane is
 * also where the panel-owned REALITY private key appears — it is
 * admin-only, behind Cloudflare Access, and never cached.
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { FormEvent } from "react";

import { getNodeConfig, getNodeRuntime, putNodeConfig } from "../api";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import JsonPanel from "../components/JsonPanel";
import { inputClass, primaryButton, secondaryButton } from "../components/styles";
import { shortHash } from "../lib/format";
import type { NodeRuntimeOut } from "../types";
import type { NodeOutletContext } from "./NodeLayout";

interface Notice {
  ok: boolean;
  text: string;
}

export default function NodeConfigPage() {
  const { nodeId, reload } = useOutletContext<NodeOutletContext>();
  const [authored, setAuthored] = useState<unknown>(undefined);
  const [runtime, setRuntime] = useState<NodeRuntimeOut | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [authoredResult, runtimeResult] = await Promise.all([
      getNodeConfig(nodeId),
      getNodeRuntime(nodeId),
    ]);
    if (authoredResult.error && authoredResult.status !== 404) {
      setError(authoredResult.error);
      return;
    }
    if (runtimeResult.error && runtimeResult.status !== 404) {
      setError(runtimeResult.error);
      return;
    }
    setError(null);
    setAuthored(authoredResult.data ?? null);
    setRuntime(runtimeResult.data ?? null);
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setNotice({ ok: false, text: "Invalid JSON — check the syntax." });
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await putNodeConfig(nodeId, parsed);
    setBusy(false);
    if (result.error) {
      setNotice({ ok: false, text: `Save failed: ${result.error}` });
      return;
    }
    setNotice({
      ok: true,
      text: "Config saved. The node applies it on its next heartbeat.",
    });
    setText("");
    await load();
    await reload();
  };

  return (
    <div className="space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid gap-4 lg:grid-cols-2">
        <JsonPanel
          title="Authored config"
          subtitle="the document you provide, local tags only"
          value={authored}
          empty="No config loaded yet."
        />
        <JsonPanel
          title="Rendered config"
          subtitle={
            runtime ? `hash ${shortHash(runtime.hash)} — what the node runs` : undefined
          }
          value={runtime ? runtime.config : runtime}
          empty="Not renderable yet — no config, or the last render failed."
        />
      </div>
      {runtime && runtime.warnings.length > 0 && (
        <ul className="list-inside list-disc rounded-xl border border-[#ffcc00]/30 bg-[#fff9e6] px-4 py-3 text-sm text-amber-700">
          {runtime.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <form
        onSubmit={save}
        className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-5 shadow-sm"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
          Replace config
        </h2>
        <p className="text-xs text-apple-muted">
          Paste the full authored JSON. Local tags only — a qualified name is
          rejected, not rewritten.
        </p>
        <textarea
          className={`${inputClass} h-48 w-full resize-y font-mono text-xs`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder='{"inbounds": [...], "outbounds": [...], ...}'
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className={primaryButton}
            disabled={busy || !text.trim()}
          >
            {busy ? "Saving…" : "Save config"}
          </button>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => void load()}
          >
            Reload
          </button>
          {notice &&
            (notice.ok ? (
              <p className="text-sm text-apple-green">{notice.text}</p>
            ) : (
              <p className="text-sm text-apple-red">{notice.text}</p>
            ))}
        </div>
        {authored === null && (
          <EmptyState>This node has no config yet — paste one above.</EmptyState>
        )}
      </form>
    </div>
  );
}
