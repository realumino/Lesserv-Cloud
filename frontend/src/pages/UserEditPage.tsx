/**
 * Create or edit one user, with access as per-node sections.
 *
 * WHY the sections are built from the node list: the admin never types or
 * even sees a qualified name here. Each section is headed by the node's
 * stored label and contains only that node's local tags, which is the M5
 * done-when's "node label as the header, local tags inside".
 *
 * WHY the access map is authoritative: a node left unchecked is omitted
 * from the payload, and the server deletes that access row. The pure rules
 * live in lib/access.ts and are unit-tested; this page is the plumbing.
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useParams } from "react-router";

import {
  createUser,
  getNodeInbounds,
  getNodeOutbounds,
  getUser,
  listNodes,
  updateUser,
} from "../api";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import { inputClass, primaryButton, secondaryButton } from "../components/styles";
import SubscriptionCard from "../components/SubscriptionCard";
import type { AccessForm, NodeAccessSection } from "../lib/access";
import {
  emptyAccessForm,
  formFromUser,
  toAccessPayload,
  toggleNode,
  toggleTag,
} from "../lib/access";
import { fromLocalInput, toLocalInput } from "../lib/format";
import type { NodeOut } from "../types";

interface TagsByNode {
  inbounds: string[];
  outbounds: string[];
}

interface GlobalFields {
  status: string;
  hasExpire: boolean;
  expireLocal: string;
  note: string;
}

const BLANK_GLOBAL: GlobalFields = {
  status: "active",
  hasExpire: false,
  expireLocal: "",
  note: "",
};

export default function UserEditPage() {
  const { username } = useParams();
  const isEdit = Boolean(username);
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<NodeOut[] | null>(null);
  const [tags, setTags] = useState<Record<string, TagsByNode>>({});
  const [form, setForm] = useState<AccessForm>({});
  const [global, setGlobal] = useState<GlobalFields>(BLANK_GLOBAL);
  const [usernameInput, setUsernameInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const nodeResult = await listNodes();
      if (cancelled) {
        return;
      }
      if (nodeResult.error) {
        setError(nodeResult.error);
        return;
      }
      const list = nodeResult.data ?? [];
      const nodeTags = await loadTags(list);
      if (cancelled) {
        return;
      }
      setTags(nodeTags);
      if (isEdit) {
        const userResult = await getUser(username!);
        if (cancelled) {
          return;
        }
        if (userResult.error || !userResult.data) {
          setError(userResult.error ?? "user not found");
          return;
        }
        setForm(formFromUser(userResult.data, list));
        setGlobal(globalFromUser(userResult.data));
      } else {
        setForm(emptyAccessForm(list));
      }
      setNodes(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [username, isEdit]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (global.hasExpire && !global.expireLocal) {
      setError("Pick an expiry date or uncheck the box.");
      return;
    }
    const expire = global.hasExpire ? fromLocalInput(global.expireLocal) : null;
    const access = toAccessPayload(form);
    setBusy(true);
    setError(null);
    const result = isEdit
      ? await updateUser(username!, {
          status: global.status,
          expire,
          note: global.note || null,
          access,
        })
      : await createUser({
          username: usernameInput.trim(),
          status: global.status,
          expire,
          note: global.note || null,
          access,
        });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    navigate("/users");
  };

  if (nodes === null) {
    return <EmptyState>Loading user…</EmptyState>;
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-bold">
        {isEdit ? `Edit ${username}` : "Add user"}
      </h1>
      {error && <ErrorNote>{error}</ErrorNote>}
      <GlobalSection
        isEdit={isEdit}
        username={username}
        usernameInput={usernameInput}
        onUsername={setUsernameInput}
        global={global}
        onChange={setGlobal}
      />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
          Access by node
        </h2>
        <p className="text-xs text-apple-muted">
          Each section is one node. The checkboxes are that node's local tags;
          unchecking membership removes the node's access row on save.
        </p>
        {nodes.length === 0 ? (
          <EmptyState>No nodes exist yet — create one first.</EmptyState>
        ) : (
          nodes.map((node) => (
            <AccessSection
              key={node.id}
              node={node}
              section={form[node.id]}
              tags={tags[node.id] ?? { inbounds: [], outbounds: [] }}
              onToggleNode={() => setForm((current) => toggleNode(current, node.id))}
              onToggleTag={(list, tag) =>
                setForm((current) => toggleTag(current, node.id, list, tag))
              }
            />
          ))
        )}
      </section>
      {isEdit && (
        <div className="pt-2">
          <SubscriptionCard username={username!} />
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          {busy ? "Saving…" : isEdit ? "Save changes" : "Create user"}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => navigate("/users")}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The user-wide fields: identity, status, expiry, note. */
function GlobalSection({
  isEdit,
  username,
  usernameInput,
  onUsername,
  global,
  onChange,
}: {
  isEdit: boolean;
  username?: string;
  usernameInput: string;
  onUsername: (value: string) => void;
  global: GlobalFields;
  onChange: (value: GlobalFields) => void;
}) {
  return (
    <section className="flex flex-wrap items-end gap-3 rounded-2xl border border-apple-border bg-apple-card p-5 shadow-sm">
      <Field label="Username">
        {isEdit ? (
          <p className="py-2 font-mono text-sm">{username}</p>
        ) : (
          <input
            className={inputClass}
            value={usernameInput}
            onChange={(event) => onUsername(event.target.value)}
            placeholder="alice"
          />
        )}
      </Field>
      <Field label="Status">
        <select
          className={inputClass}
          value={global.status}
          onChange={(event) => onChange({ ...global, status: event.target.value })}
        >
          <option value="active">active</option>
          <option value="disabled">disabled</option>
        </select>
      </Field>
      <Field label="Expiry">
        <label className="mb-1 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-apple-blue"
            checked={global.hasExpire}
            onChange={(event) =>
              onChange({ ...global, hasExpire: event.target.checked })
            }
          />
          Expires at a date
        </label>
        {global.hasExpire && (
          <input
            type="datetime-local"
            className={inputClass}
            value={global.expireLocal}
            onChange={(event) =>
              onChange({ ...global, expireLocal: event.target.value })
            }
          />
        )}
      </Field>
      <Field label="Note">
        <input
          className={inputClass}
          value={global.note}
          onChange={(event) => onChange({ ...global, note: event.target.value })}
        />
      </Field>
    </section>
  );
}

/** One node's membership and tag checkboxes. */
function AccessSection({
  node,
  section,
  tags,
  onToggleNode,
  onToggleTag,
}: {
  node: NodeOut;
  section: NodeAccessSection | undefined;
  tags: TagsByNode;
  onToggleNode: () => void;
  onToggleTag: (list: "inbound" | "outbound", tag: string) => void;
}) {
  const authorized = section?.authorized ?? false;
  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm ${
        authorized ? "border-apple-blue/40 bg-apple-card" : "border-apple-border bg-apple-card"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-apple-blue"
            checked={authorized}
            onChange={onToggleNode}
          />
          <span className="font-semibold">{node.label}</span>
        </label>
        <span className="font-mono text-xs text-apple-muted">{node.id}</span>
        {!node.has_config && <Badge tone="idle">no config</Badge>}
      </div>
      {authorized && section && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <TagList
            label="Allowed inbounds"
            options={tags.inbounds}
            checked={section.allowedInbounds}
            onToggle={(tag) => onToggleTag("inbound", tag)}
          />
          <TagList
            label="Allowed outbounds"
            options={tags.outbounds}
            checked={section.allowedOutbounds}
            onToggle={(tag) => onToggleTag("outbound", tag)}
          />
        </div>
      )}
    </div>
  );
}

/** A grid of local-tag checkboxes with an empty state. */
function TagList({
  label,
  options,
  checked,
  onToggle,
}: {
  label: string;
  options: string[];
  checked: string[];
  onToggle: (tag: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-apple-muted">
        {label}
      </p>
      {options.length === 0 ? (
        <p className="text-xs text-apple-muted">
          None available — the node has no config, or declares none.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {options.map((tag) => (
            <label
              key={tag}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-apple-border px-3 py-2 text-sm hover:border-apple-blue/40"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-apple-blue"
                checked={checked.includes(tag)}
                onChange={() => onToggle(tag)}
              />
              <span className="font-mono">{tag}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fetch each node's local inbound and outbound tags (503 = no config). */
async function loadTags(nodes: NodeOut[]): Promise<Record<string, TagsByNode>> {
  const entries = await Promise.all(
    nodes.map(async (node) => {
      const [inboundResult, outboundResult] = await Promise.all([
        getNodeInbounds(node.id),
        getNodeOutbounds(node.id),
      ]);
      return [
        node.id,
        {
          inbounds: (inboundResult.data ?? []).map((item) => item.tag),
          outbounds: (outboundResult.data ?? []).map((item) => item.tag),
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/** Project a stored user onto the form's global fields. */
function globalFromUser(user: {
  status: string;
  expire: number | null;
  note: string | null;
}): GlobalFields {
  const expires = Boolean(user.expire && user.expire > 0);
  return {
    status: user.status,
    hasExpire: expires,
    expireLocal: expires ? toLocalInput(user.expire!) : "",
    note: user.note ?? "",
  };
}
