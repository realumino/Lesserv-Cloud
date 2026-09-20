/**
 * The user list with a per-node membership summary.
 *
 * WHY the summary counts per node: access is stored per (user, node), so
 * "which nodes is this user on, and with how many in/out gains" is the
 * question the list exists to answer, and it must never show a qualified
 * name.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { deleteUser, listNodes, listUsers } from "../api";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import ShareLinksDialog from "../components/ShareLinksDialog";
import { primaryButton, secondaryButton } from "../components/styles";
import { fmtExpire } from "../lib/format";
import type { NodeOut, UserOut } from "../types";

export default function UsersPage() {
  const [users, setUsers] = useState<UserOut[] | null>(null);
  const [nodes, setNodes] = useState<NodeOut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [userResult, nodeResult] = await Promise.all([listUsers(), listNodes()]);
    if (userResult.error) {
      setError(userResult.error);
      return;
    }
    setError(null);
    setUsers(userResult.data ?? []);
    setNodes(nodeResult.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (username: string) => {
    const result = await deleteUser(username);
    if (result.error) {
      setNotice(`Delete failed: ${result.error}`);
      return;
    }
    setNotice(null);
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Users</h1>
        <div className="flex gap-2">
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Refresh
          </button>
          <Link className={primaryButton} to="/users/new">
            Add user
          </Link>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <ErrorNote>{notice}</ErrorNote>}
      {users === null ? (
        <EmptyState>Loading users…</EmptyState>
      ) : users.length === 0 ? (
        <EmptyState>No users yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-apple-border bg-apple-card shadow-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-apple-border bg-apple-gray-surface text-left text-xs uppercase tracking-wide text-apple-muted">
                <Th>User</Th>
                <Th>Status</Th>
                <Th>Expiry</Th>
                <Th>Nodes</Th>
                <Th>Note</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.username} className="border-b border-apple-border last:border-b-0">
                  <Td>
                    <Link
                      to={`/users/${encodeURIComponent(user.username)}`}
                      className="font-mono font-semibold text-apple-blue hover:text-apple-blue-hover"
                    >
                      {user.username}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={user.status === "active" ? "ok" : "idle"}>
                      {user.status}
                    </Badge>
                  </Td>
                  <Td className="text-apple-muted">{fmtExpire(user.expire)}</Td>
                  <Td className="text-apple-muted">{membershipSummary(user, nodes)}</Td>
                  <Td className="max-w-48 truncate text-apple-muted" title={user.note ?? ""}>
                    {user.note || "—"}
                  </Td>
                  <Td>
                    <span className="flex gap-2">
                      <Link className={secondaryButton} to={`/users/${encodeURIComponent(user.username)}`}>
                        Edit
                      </Link>
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() => setShareFor(user.username)}
                      >
                        Share
                      </button>
                      <ConfirmButton
                        className={secondaryButton}
                        message={`Delete user "${user.username}"? Their access rows are removed too.`}
                        onConfirm={() => void remove(user.username)}
                      >
                        Delete
                      </ConfirmButton>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shareFor && (
        <ShareLinksDialog username={shareFor} onClose={() => setShareFor(null)} />
      )}
    </div>
  );
}

/** Readable per-node membership: labels only, counts inside. */
function membershipSummary(user: UserOut, nodes: NodeOut[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    const access = user.access[node.id];
    if (access) {
      parts.push(
        `${node.label} (${access.allowed_inbounds.length} in / ${access.allowed_outbounds.length} out)`,
      );
    }
  }
  return parts.join("; ") || "none";
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
