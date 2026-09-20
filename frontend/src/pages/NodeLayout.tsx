/**
 * The node detail shell: header facts plus one tab per node-scoped view.
 *
 * WHY a layout route: the header facts are fetched once and shared by the
 * config, keys, users, and profiles tabs, so switching tabs never refetches
 * the node, and every tab is a real refreshable child URL
 * (/admin/nodes/tokyo01/config — the M5 done-when's example).
 *
 * WHY the child context exposes reload: a mutation on any tab (save a
 * config, rotate a key, add a profile) changes the header's drift view, and
 * the tab asks the shell to refetch instead of duplicating that logic.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, Outlet, useParams } from "react-router";

import { getNode, getNodeSync, mintNodeToken } from "../api";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import ErrorNote from "../components/ErrorNote";
import HashChip from "../components/HashChip";
import TokenDialog from "../components/TokenDialog";
import { primaryButton, secondaryButton } from "../components/styles";
import { STATE_LABEL, STATE_TONE, fleetState } from "../lib/fleet";
import { relativeTime } from "../lib/format";
import type { NodeOut, NodeSyncOut } from "../types";

/** What every node tab gets from the layout: the id and a refetch. */
export interface NodeOutletContext {
  nodeId: string;
  reload: () => Promise<void>;
}

export default function NodeLayout() {
  const { nodeId = "" } = useParams();
  const [node, setNode] = useState<NodeOut | null>(null);
  const [sync, setSync] = useState<NodeSyncOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [nodeResult, syncResult] = await Promise.all([
      getNode(nodeId),
      getNodeSync(nodeId),
    ]);
    if (nodeResult.error) {
      setError(nodeResult.error);
      return;
    }
    setError(null);
    setNode(nodeResult.data);
    setSync(syncResult.data);
  }, [nodeId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mint = async () => {
    const result = await mintNodeToken(nodeId);
    if (result.error) {
      setError(result.error);
      return;
    }
    setToken(result.data?.token ?? null);
  };

  if (error) {
    return <ErrorNote>{error}</ErrorNote>;
  }
  if (!node) {
    return <p className="text-sm text-apple-muted">Loading node…</p>;
  }

  return (
    <section className="space-y-4">
      <NodeHeader
        node={node}
        sync={sync}
        active={sync?.state === "active"}
        onMint={() => void mint()}
        onRefresh={() => void reload()}
      />
      <nav className="flex gap-2">
        <Tab to="config">Config</Tab>
        <Tab to="keys">Keys</Tab>
        <Tab to="users">Users</Tab>
        <Tab to="profiles">Profiles</Tab>
      </nav>
      <Outlet context={{ nodeId, reload } satisfies NodeOutletContext} />
      {token && (
        <TokenDialog nodeId={nodeId} token={token} onClose={() => setToken(null)} />
      )}
    </section>
  );
}

/** The header card: identity, drift facts, and the two node-level actions. */
function NodeHeader({
  node,
  sync,
  active,
  onMint,
  onRefresh,
}: {
  node: NodeOut;
  sync: NodeSyncOut | null;
  active: boolean;
  onMint: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">{node.label}</h1>
        <span className="font-mono text-xs text-apple-muted">{node.id}</span>
        {sync && (
          <Badge tone={STATE_TONE[fleetState(sync)]}>
            {STATE_LABEL[fleetState(sync)]}
          </Badge>
        )}
        <span className="ml-auto flex gap-2">
          <button type="button" className={secondaryButton} onClick={onRefresh}>
            Refresh
          </button>
          {active ? (
            <ConfirmButton
              className={secondaryButton}
              message={`Rotate ${node.id}'s token? The node's agent is rejected until agent.toml is updated with the new token.`}
              onConfirm={onMint}
            >
              Rotate token
            </ConfirmButton>
          ) : (
            <button type="button" className={primaryButton} onClick={onMint}>
              Mint token
            </button>
          )}
        </span>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Address" value={node.address || "—"} />
        <Fact label="Last seen" value={relativeTime(sync?.last_seen ?? null)} />
        <Fact label="Health" value={sync?.health ?? "—"} />
        <Fact label="Agent" value={sync?.agent_version ?? "—"} />
        <Fact label="Applied" value={<HashChip hash={sync?.applied_hash ?? null} />} />
        <Fact label="Desired" value={<HashChip hash={sync?.desired_hash ?? null} />} />
        <Fact label="Xray" value={sync?.xray_version ?? "—"} />
        <Fact label="Last error" value={sync?.last_error ?? "—"} />
      </dl>
      {sync && sync.warnings.length > 0 && (
        <ul className="list-inside list-disc text-sm text-amber-700">
          {sync.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One label/value pair in the header grid. */
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-apple-muted">
        {label}
      </dt>
      <dd className="text-apple-text">{value}</dd>
    </div>
  );
}

/** One tab link with active styling. */
function Tab({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-full px-5 py-2 text-sm font-medium transition-colors ${
          isActive
            ? "bg-apple-blue text-white shadow-sm"
            : "bg-apple-card text-apple-muted hover:bg-apple-gray-surface hover:text-apple-text"
        }`
      }
    >
      {children}
    </NavLink>
  );
}
