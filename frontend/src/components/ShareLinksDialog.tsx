/**
 * The share-link dialog for one user.
 *
 * WHY it fetches its own data: links are a read-only view over existing
 * config, access, key, and profile rows, and the list page does not need
 * to own that state. Warnings (a configless node, a disabled user) are
 * shown as-is — they explain an empty or partial list.
 */
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { getUserLinks } from "../api";
import CopyButton from "./CopyButton";
import EmptyState from "./EmptyState";
import ErrorNote from "./ErrorNote";
import Modal from "./Modal";
import { secondaryButton } from "./styles";
import type { ShareLink } from "../types";

export default function ShareLinksDialog({
  username,
  onClose,
}: {
  username: string;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getUserLinks(username);
      if (cancelled) {
        return;
      }
      if (result.error) {
        setError(result.error);
        setLinks([]);
        return;
      }
      setError(null);
      setLinks(result.data?.links ?? []);
      setWarnings(result.data?.warnings ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  return (
    <Modal title={`Share links for ${username}`} onClose={onClose} wide>
      {error && <ErrorNote>{error}</ErrorNote>}
      {warnings.length > 0 && (
        <div className="space-y-1 rounded-xl border border-[#ffcc00]/30 bg-[#fff9e6] px-4 py-2">
          {warnings.map((warning) => (
            <p key={warning} className="text-sm text-amber-700">
              {warning}
            </p>
          ))}
        </div>
      )}
      {links === null ? (
        <EmptyState>Loading links…</EmptyState>
      ) : links.length === 0 ? (
        <EmptyState>No shareable links.</EmptyState>
      ) : (
        <div className="space-y-3">
          {links.map((link) => (
            <LinkRow
              key={`${link.node}-${link.inbound}-${link.outbound}-${link.profile ?? "direct"}`}
              link={link}
              showQr={qrFor === link.uri}
              onToggleQr={() => setQrFor(qrFor === link.uri ? null : link.uri)}
            />
          ))}
          <div className="flex justify-end">
            <CopyButton
              text={links.map((link) => link.uri).join("\n")}
              label="Copy all"
            />
          </div>
        </div>
      )}
    </Modal>
  );
}

/** One link: its readable label, remote email, URI, copy, and optional QR. */
function LinkRow({
  link,
  showQr,
  onToggleQr,
}: {
  link: ShareLink;
  showQr: boolean;
  onToggleQr: () => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-apple-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-apple-muted">
          {link.label ?? `${link.inbound} → ${link.outbound}`}
        </span>
        <span className="truncate font-mono text-xs text-apple-muted">{link.email}</span>
      </div>
      <div className="break-all rounded-lg bg-apple-gray-surface px-3 py-2 font-mono text-xs">
        {link.uri}
      </div>
      <div className="flex gap-2">
        <CopyButton text={link.uri} />
        <button type="button" className={secondaryButton} onClick={onToggleQr}>
          {showQr ? "Hide QR" : "QR"}
        </button>
      </div>
      {showQr && (
        <div className="flex justify-center pt-2">
          <QRCodeSVG value={link.uri} size={176} marginSize={2} />
        </div>
      )}
    </div>
  );
}
