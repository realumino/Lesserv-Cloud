/**
 * The one-time node token display.
 *
 * WHY it exists: the server stores only a hash, so the plaintext is shown
 * exactly once at mint time. The dialog holds it in component state only —
 * never localStorage, never a log — and the admin is told to copy it into
 * agent.toml now.
 */
import CopyButton from "./CopyButton";
import Modal from "./Modal";

export default function TokenDialog({
  nodeId,
  token,
  onClose,
}: {
  nodeId: string;
  token: string;
  onClose: () => void;
}) {
  return (
    <Modal title={`Token for ${nodeId}`} onClose={onClose}>
      <p className="text-sm text-apple-muted">
        Copy this now — it is shown once and never stored in plaintext. Put it
        in <code className="font-mono">agent.toml</code> (mode 0600) on the node.
      </p>
      <code className="block break-all rounded-xl border border-apple-border bg-apple-bg p-3 font-mono text-xs">
        {token}
      </code>
      <div className="flex justify-end">
        <CopyButton text={token} label="Copy token" />
      </div>
    </Modal>
  );
}
