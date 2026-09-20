/**
 * Per-inbound link profiles for one node.
 *
 * WHY profiles live on the node: a profile is an extra client-side view of
 * one inbound (CDN fronting, a different port), so it attaches to a local
 * inbound tag and only ever affects generated share links — never the
 * rendered runtime config. The inbound select therefore offers exactly the
 * tags the authored config declares, and nothing qualified.
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { FormEvent } from "react";

import {
  createNodeProfile,
  deleteNodeProfile,
  getNodeInbounds,
  listNodeProfiles,
  updateNodeProfile,
} from "../api";
import ConfirmButton from "../components/ConfirmButton";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import { dangerButton, inputClass, primaryButton, secondaryButton } from "../components/styles";
import type { InboundSummary, LinkProfileIn, LinkProfileOut } from "../types";
import type { NodeOutletContext } from "./NodeLayout";

export default function NodeProfilesPage() {
  const { nodeId, reload } = useOutletContext<NodeOutletContext>();
  const [inbounds, setInbounds] = useState<InboundSummary[] | null | undefined>(
    undefined,
  );
  const [profiles, setProfiles] = useState<LinkProfileOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [inboundResult, profileResult] = await Promise.all([
      getNodeInbounds(nodeId),
      listNodeProfiles(nodeId),
    ]);
    if (inboundResult.status === 503) {
      setInbounds(null);
    } else if (inboundResult.error) {
      setError(inboundResult.error);
      return;
    } else {
      setInbounds(inboundResult.data ?? []);
    }
    if (profileResult.error) {
      setError(profileResult.error);
      return;
    }
    setError(null);
    setProfiles(profileResult.data ?? []);
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = async () => {
    setCreating(false);
    setEditing(null);
    await load();
    await reload();
  };

  const remove = async (profileId: string) => {
    const result = await deleteNodeProfile(nodeId, profileId);
    if (result.error) {
      setError(result.error);
      return;
    }
    await afterMutation();
  };

  if (inbounds === undefined) {
    return <EmptyState>Loading profiles…</EmptyState>;
  }
  if (inbounds === null) {
    return <EmptyState>This node has no config, so it has no inbounds to attach a profile to.</EmptyState>;
  }

  return (
    <div className="space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
          Link profiles
        </h2>
        {!creating && (
          <button
            type="button"
            className={primaryButton}
            onClick={() => setCreating(true)}
          >
            Add profile
          </button>
        )}
      </div>
      <p className="text-xs text-apple-muted">
        A profile adds one URI per allowed exit for this inbound. It never
        changes the runtime config — only generated links.
      </p>

      {creating && (
        <ProfileForm
          mode="create"
          inbounds={inbounds}
          nodeId={nodeId}
          onSaved={() => void afterMutation()}
          onCancel={() => setCreating(false)}
        />
      )}

      {profiles === null ? (
        <EmptyState>Loading…</EmptyState>
      ) : profiles.length === 0 && !creating ? (
        <EmptyState>No profiles yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {profiles.map((profile) =>
            editing === profile.id ? (
              <ProfileForm
                key={profile.id}
                mode="edit"
                inbounds={inbounds}
                nodeId={nodeId}
                initial={profile}
                onSaved={() => void afterMutation()}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <ProfileRow
                key={profile.id}
                profile={profile}
                onEdit={() => setEditing(profile.id)}
                onDelete={() => void remove(profile.id)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** One profile in read mode, with its edit and delete actions. */
function ProfileRow({
  profile,
  onEdit,
  onDelete,
}: {
  profile: LinkProfileOut;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-apple-border bg-apple-card p-3">
      <span className="font-mono text-sm font-semibold">{profile.id}</span>
      <span className="text-xs font-semibold uppercase tracking-wide text-apple-muted">
        {profile.inbound_tag}
      </span>
      <span className="text-sm">{profile.label}</span>
      <code className="min-w-40 flex-1 truncate rounded-lg bg-apple-gray-surface px-3 py-1.5 font-mono text-xs">
        {JSON.stringify(profile.overrides)}
      </code>
      <button type="button" className={secondaryButton} onClick={onEdit}>
        Edit
      </button>
      <ConfirmButton
        className={dangerButton}
        message={`Delete profile "${profile.id}"? Links for it disappear.`}
        onConfirm={onDelete}
      >
        Delete
      </ConfirmButton>
    </div>
  );
}

/** The create/edit form for one profile; overrides are edited as JSON. */
function ProfileForm({
  mode,
  inbounds,
  nodeId,
  initial,
  onSaved,
  onCancel,
}: {
  mode: "create" | "edit";
  inbounds: InboundSummary[];
  nodeId: string;
  initial?: LinkProfileOut;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [inboundTag, setInboundTag] = useState(
    initial?.inbound_tag ?? inbounds[0]?.tag ?? "",
  );
  const [label, setLabel] = useState(initial?.label ?? "");
  const [overridesText, setOverridesText] = useState(
    JSON.stringify(initial?.overrides ?? {}, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let overrides: unknown;
    try {
      overrides = JSON.parse(overridesText || "{}");
    } catch {
      setError("Overrides must be valid JSON.");
      return;
    }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      setError("Overrides must be a JSON object.");
      return;
    }
    const body: Omit<LinkProfileIn, "id"> = {
      inbound_tag: inboundTag,
      label: label.trim(),
      overrides: overrides as Record<string, string | number>,
    };
    setBusy(true);
    setError(null);
    const result =
      mode === "create"
        ? await createNodeProfile(nodeId, { id: id.trim(), ...body })
        : await updateNodeProfile(nodeId, initial!.id, body);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved();
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-4 shadow-sm"
    >
      <h3 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
        {mode === "create" ? "New profile" : `Edit ${initial?.id}`}
      </h3>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="ID" hint="lowercase letters, digits, hyphens">
          <input
            className={inputClass}
            value={id}
            onChange={(event) => setId(event.target.value)}
            disabled={mode === "edit"}
            placeholder="cdn"
          />
        </Field>
        <Field label="Inbound">
          <select
            className={inputClass}
            value={inboundTag}
            onChange={(event) => setInboundTag(event.target.value)}
          >
            {inbounds.map((inbound) => (
              <option key={inbound.tag} value={inbound.tag}>
                {inbound.tag}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Label">
          <input
            className={inputClass}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="CDN"
          />
        </Field>
      </div>
      <Field label="Overrides (JSON object)" hint="address, port, sni, host, path, …">
        <textarea
          className={`${inputClass} h-28 w-full resize-y font-mono text-xs`}
          value={overridesText}
          onChange={(event) => setOverridesText(event.target.value)}
          spellCheck={false}
        />
      </Field>
      <div className="flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
