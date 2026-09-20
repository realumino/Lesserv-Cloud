/**
 * The panel-owned REALITY keys for one node.
 *
 * WHY only public keys are shown: the private key never leaves the process,
 * and clients only need `pbk`. Rotation is deliberate and breaks every link
 * that used the old key, so both actions are confirm-gated and the runtime
 * pane is refreshed afterwards (the render now carries the new key).
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";

import {
  getNodeReality,
  rotateNodeReality,
  rotateNodeRealityKey,
} from "../api";
import ConfirmButton from "../components/ConfirmButton";
import CopyButton from "../components/CopyButton";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import { dangerButton, secondaryButton } from "../components/styles";
import { fmtTimestamp } from "../lib/format";
import type { RealityKey } from "../types";
import type { NodeOutletContext } from "./NodeLayout";

export default function NodeKeysPage() {
  const { nodeId, reload } = useOutletContext<NodeOutletContext>();
  const [keys, setKeys] = useState<RealityKey[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await getNodeReality(nodeId);
    if (result.status === 404) {
      setKeys(null);
      setError(null);
      return;
    }
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setKeys(result.data?.keys ?? []);
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rotate = async (tag: string) => {
    setRotating(tag);
    setNotice(null);
    const result = await rotateNodeRealityKey(nodeId, tag);
    setRotating(null);
    if (result.error) {
      setNotice(`Rotate failed: ${result.error}`);
      return;
    }
    setNotice(`Key rotated for "${tag}". Existing links stop working.`);
    await load();
    await reload();
  };

  const rotateAll = async () => {
    setRotating("*");
    setNotice(null);
    const result = await rotateNodeReality(nodeId);
    setRotating(null);
    if (result.error) {
      setNotice(`Rotate failed: ${result.error}`);
      return;
    }
    setNotice(`Rotated ${result.data?.rotated.length ?? 0} key(s).`);
    await load();
    await reload();
  };

  return (
    <div className="space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <p className="text-sm text-apple-muted">{notice}</p>}
      {keys === undefined ? (
        <EmptyState>Loading keys…</EmptyState>
      ) : keys === null ? (
        <EmptyState>This node has no config, so it has no REALITY inbounds.</EmptyState>
      ) : keys.length === 0 ? (
        <EmptyState>No REALITY inbounds in this node's config.</EmptyState>
      ) : (
        <section className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
              REALITY keys
            </h2>
            {keys.length > 1 && (
              <ConfirmButton
                className={dangerButton}
                disabled={rotating !== null}
                message={`Rotate ALL ${keys.length} REALITY keys? Every client using an old key stops working.`}
                onConfirm={() => void rotateAll()}
              >
                {rotating === "*" ? "Rotating…" : "Rotate all"}
              </ConfirmButton>
            )}
          </div>
          <div className="space-y-3">
            {keys.map((key) => (
              <KeyRow
                key={key.inbound}
                row={key}
                rotating={rotating}
                onRotate={() => void rotate(key.inbound)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** One REALITY inbound: local tag, derived public key, and its rotation. */
function KeyRow({
  row,
  rotating,
  onRotate,
}: {
  row: RealityKey;
  rotating: string | null;
  onRotate: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-apple-border p-3">
      <span className="min-w-24 text-xs font-semibold uppercase tracking-wide text-apple-muted">
        {row.inbound}
      </span>
      {row.public_key ? (
        <>
          <code className="min-w-48 flex-1 break-all rounded-lg bg-apple-gray-surface px-3 py-1.5 font-mono text-xs">
            pbk: {row.public_key}
          </code>
          <CopyButton text={row.public_key} />
        </>
      ) : (
        <span className="flex-1 text-sm text-apple-muted">
          Key pending — generated on the next render.
        </span>
      )}
      <span className="text-xs text-apple-muted">
        {row.created_at ? `from ${fmtTimestamp(row.created_at)}` : ""}
      </span>
      <ConfirmButton
        className={secondaryButton}
        disabled={rotating !== null}
        message={`Rotate the REALITY key for "${row.inbound}"? Clients using the old key stop working until they re-import.`}
        onConfirm={onRotate}
      >
        {rotating === row.inbound ? "Rotating…" : "Rotate"}
      </ConfirmButton>
    </div>
  );
}
