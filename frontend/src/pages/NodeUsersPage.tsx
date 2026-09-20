/**
 * The users authorized on one node.
 *
 * WHY it filters the global user list instead of a dedicated endpoint: the
 * API has no per-node user list, and the M5 decision is to prove the
 * existing surface is enough. Membership is the presence of an
 * `access[nodeId]` entry, which is exactly what the server stores.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useOutletContext } from "react-router";

import { listUsers } from "../api";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import { secondaryButton } from "../components/styles";
import { fmtExpire } from "../lib/format";
import type { UserOut } from "../types";
import type { NodeOutletContext } from "./NodeLayout";

export default function NodeUsersPage() {
  const { nodeId } = useOutletContext<NodeOutletContext>();
  const [members, setMembers] = useState<UserOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listUsers();
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setMembers((result.data ?? []).filter((user) => user.access[nodeId]));
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
          Users on this node
        </h2>
        <div className="flex gap-2">
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Refresh
          </button>
          <Link className={secondaryButton} to="/users/new">
            Add user
          </Link>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {members === null ? (
        <EmptyState>Loading users…</EmptyState>
      ) : members.length === 0 ? (
        <EmptyState>No user is authorized on this node yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-apple-border bg-apple-card shadow-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-apple-border bg-apple-gray-surface text-left text-xs uppercase tracking-wide text-apple-muted">
                <Th>User</Th>
                <Th>Status</Th>
                <Th>Expiry</Th>
                <Th>Allowed inbounds</Th>
                <Th>Allowed outbounds</Th>
              </tr>
            </thead>
            <tbody>
              {members.map((user) => {
                const access = user.access[nodeId];
                return (
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
                    <Td className="text-apple-muted">
                      {access.allowed_inbounds.join(", ") || "—"}
                    </Td>
                    <Td className="text-apple-muted">
                      {access.allowed_outbounds.join(", ") || "—"}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
}: {
  children: ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 ${className}`}>{children}</td>;
}
