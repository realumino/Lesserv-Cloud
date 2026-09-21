/**
 * The user's subscription URL: display, copy, QR, and rotation.
 *
 * WHY it fetches its own user: the card is mounted in two places (the share
 * dialog and the user edit page), and owning its fetch plus its token state
 * means rotation behaves identically everywhere with no parent plumbing.
 * The token is a capability URL, re-displayable by design (plaintext at
 * rest, docs/M6-PLAN.md) — this card is the only place the SPA shows it.
 */
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { getUser, rotateSubToken } from "../api";
import ConfirmButton from "./ConfirmButton";
import CopyButton from "./CopyButton";
import ErrorNote from "./ErrorNote";
import { secondaryButton } from "./styles";
import { fmtTimestamp } from "../lib/format";
import { subscriptionUrl } from "../lib/subscription";
import type { UserOut } from "../types";

export default function SubscriptionCard({ username }: { username: string }) {
  const [user, setUser] = useState<UserOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getUser(username);
      if (cancelled) {
        return;
      }
      if (result.error || !result.data) {
        setError(result.error ?? "user not found");
        return;
      }
      setError(null);
      setUser(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  const mint = async () => {
    setBusy(true);
    const result = await rotateSubToken(username);
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? "rotation failed");
      return;
    }
    setError(null);
    // Patch the local copy so the URL updates without a refetch.
    setUser((current) =>
      current
        ? {
            ...current,
            sub_token: result.data!.sub_token,
            sub_token_created_at: result.data!.created_at,
          }
        : current,
    );
  };

  const url = subscriptionUrl(window.location.origin, user?.sub_token ?? null);

  return (
    <section className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
          Subscription
        </h2>
        {user?.sub_token_created_at && (
          <span className="text-xs text-apple-muted">
            token minted {fmtTimestamp(user.sub_token_created_at)}
          </span>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {url ? (
        <>
          <div className="break-all rounded-lg bg-apple-gray-surface px-3 py-2 font-mono text-xs">
            {url}
          </div>
          <p className="text-xs text-apple-muted">
            One URL for every node this user may use. A disabled or expired
            user receives an empty list.
          </p>
          <div className="flex gap-2">
            <CopyButton text={url} label="Copy URL" />
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setShowQr((current) => !current)}
            >
              {showQr ? "Hide QR" : "QR"}
            </button>
            <ConfirmButton
              className={secondaryButton}
              message="Rotate the subscription token? The current URL stops working immediately, and every client must re-import the new one."
              onConfirm={() => void mint()}
            >
              Rotate
            </ConfirmButton>
          </div>
          {showQr && (
            <div className="flex justify-center pt-2">
              <QRCodeSVG value={url} size={176} marginSize={2} />
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-apple-muted">
            No subscription URL yet — generate one for this user.
          </p>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => void mint()}
          >
            {busy ? "Generating…" : "Generate"}
          </button>
        </>
      )}
    </section>
  );
}
