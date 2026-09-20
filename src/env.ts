/**
 * Secret-decoding helpers over the generated `Env` type.
 *
 * WHY this module exists: Python read the Worker secret from a global
 * (`workers.env`); TypeScript passes `env` explicitly from the handler into
 * the few services that need it (key_cipher, reality, render, link), and
 * this module owns the one convention for turning a secret binding into
 * bytes. The generated `worker-configuration.d.ts` defines the bindings;
 * nothing here re-declares them.
 */

const REALITY_KEY_SECRET = "REALITY_KEY_SECRET";

/**
 * WHAT: return the REALITY_KEY_SECRET binding as raw key bytes.
 *
 * WHY it throws instead of falling back: the secret is required to seal and
 * unseal REALITY private keys at rest, and there is deliberately no
 * plaintext fallback. A missing or empty binding is a misconfiguration that
 * must fail loudly at the first reader. The BOM/whitespace trim mirrors the
 * Python behavior, where PowerShell pipes can prepend a BOM to the value.
 */
export function secretBytes(env: Env): Uint8Array {
  const raw = env[REALITY_KEY_SECRET];
  if (!raw) {
    throw new Error(
      `${REALITY_KEY_SECRET} is not configured; REALITY keys cannot be ` +
        "sealed or unsealed without it",
    );
  }
  return base64ToBytes(raw.trim().replace(/^\uFEFF/, ""));
}

/**
 * WHAT: decode standard base64 (with padding) into bytes.
 *
 * WHY atob and not a dependency: workerd ships it, the stored format is
 * standard base64 produced by Python's `base64.b64encode`, and the decode
 * must throw on malformed input rather than guess.
 */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
