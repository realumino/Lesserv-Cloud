/**
 * The fleet view: every node with its drift and liveness at a glance.
 *
 * WHY the drift fetch is one sync call per node: the API has no bulk drift
 * endpoint, and the milestone's claim is that the existing node-scoped
 * surface is enough. The fan-out is deliberate and bounded by the fleet
 * size; a bulk endpoint can be added later without changing this page's
 * shape. A failed sync for one node leaves that row "unknown" instead of
 * blanking the table.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { FormEvent, ReactNode } from "react";

import { createNode, getNodeSync, listNodes } from "../api";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import HashChip from "../components/HashChip";
import { inputClass, primaryButton, secondaryButton } from "../components/styles";
import type { FleetRow } from "../lib/fleet";
import { STATE_LABEL, STATE_TONE, fleetRows } from "../lib/fleet";
import { relativeTime } from "../lib/format";
import type { NodeOut, NodeSyncOut } from "../types";

export default function FleetPage() {
  const [nodes, setNodes] = useState<NodeOut[] | null>(null);
  const [syncs, setSyncs] = useState<Record<string, NodeSyncOut | null>>({});
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const listing = await listNodes();
    if (listing.error) {
      setError(listing.error);
      setNodes([]);
      return;
    }
    const list = listing.data ?? [];
    setNodes(list);
    const results = await Promise.all(list.map((node) => getNodeSync(node.id)));
    const map: Record<string, NodeSyncOut | null> = {};
    list.forEach((node, index) => {
      map[node.id] = results[index].data;
    });
    setSyncs(map);
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = fleetRows(nodes ?? [], syncs);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Fleet</h1>
        <button type="button" className={secondaryButton} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <CreateNodeForm onCreated={(id) => navigate(`/nodes/${id}`)} />
      {nodes === null ? (
        <EmptyState>Loading nodes…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>No nodes yet — create the first one above.</EmptyState>
      ) : (
        <FleetTable rows={rows} />
      )}
    </div>
  );
}

/** The one table of nodes; a row links to that node's detail page. */
function FleetTable({ rows }: { rows: FleetRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-apple-border bg-apple-card shadow-sm">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-apple-border bg-apple-gray-surface text-left text-xs uppercase tracking-wide text-apple-muted">
            <Th>Node</Th>
            <Th>Domain</Th>
            <Th>Reported IP</Th>
            <Th>State</Th>
            <Th>Health</Th>
            <Th>Last seen</Th>
            <Th>Applied</Th>
            <Th>Desired</Th>
            <Th>Last error</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, sync, state }) => (
            <tr key={node.id} className="border-b border-apple-border last:border-b-0">
              <Td>
                <Link
                  to={`/nodes/${node.id}`}
                  className="font-semibold text-apple-blue transition-colors hover:text-apple-blue-hover"
                >
                  {node.label}
                </Link>
                <span className="ml-2 font-mono text-xs text-apple-muted">{node.id}</span>
              </Td>
              <Td className="text-apple-muted">{node.address || "—"}</Td>
              <Td className="text-apple-muted">{node.reported_address || "—"}</Td>
              <Td>
                <span className="flex items-center gap-2">
                  <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
                  {sync && sync.warnings.length > 0 && (
                    <span
                      className="text-xs text-amber-700"
                      title={sync.warnings.join("\n")}
                    >
                      {sync.warnings.length} warning
                      {sync.warnings.length === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
              </Td>
              <Td className="text-apple-muted">{sync?.health ?? "—"}</Td>
              <Td className="text-apple-muted">{relativeTime(sync?.last_seen ?? null)}</Td>
              <Td>
                <HashChip hash={sync?.applied_hash ?? null} />
              </Td>
              <Td>
                <HashChip hash={sync?.desired_hash ?? null} />
              </Td>
              <Td
                className="max-w-56 truncate text-apple-red"
                title={sync?.last_error ?? ""}
              >
                {sync?.last_error || "—"}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Create a node with the identity the admin must choose. The share-link
 * domain is set later on the node page, and the node's reported IP shows
 * up on its own after the agent enrolls — neither belongs in this form.
 */
function CreateNodeForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createNode({
      id: id.trim(),
      label: label.trim(),
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onCreated(id.trim());
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
        Add node
      </h2>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="ID" hint="lowercase letters and digits, max 32">
          <input
            className={inputClass}
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="tokyo01"
          />
        </Field>
        <Field label="Label">
          <input
            className={inputClass}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Tokyo 01"
          />
        </Field>
        <button
          type="submit"
          className={primaryButton}
          disabled={busy || !id.trim() || !label.trim()}
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

/** Consistent header cell padding. */
function Th({ children }: { children: ReactNode }) {
  return <th className="px-4 py-3 font-medium">{children}</th>;
}

/** Consistent body cell padding. */
function Td({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-4 py-3 ${className}`} title={title}>
      {children}
    </td>
  );
}
