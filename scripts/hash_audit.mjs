/**
 * WHAT: pre-cutover hash audit — render every node with both planes over one
 * D1 database and compare `desired_hash` node by node.
 *
 * WHY: `config_hash` is the agent's convergence contract (docs/PROTOCOL.md).
 * A divergence in canonical JSON, REALITY key handling, qualification, or
 * key sealing would make every node re-apply once on cutover, and a
 * rare-input divergence is invisible until production. This script is the
 * Phase 6 gate in docs/TS-REWRITE-PLAN.md: it boots the TypeScript plane and
 * the frozen Python reference plane against the same local D1, captures each
 * render from both, and diffs.
 *
 * WHAT the dataset is: the plan's original form audited a copy of production
 * D1, which does not exist (nothing is deployed). The dataset is therefore
 * seeded locally, and the two divergence classes the port documented —
 * whole-number floats and oversized integers in stored config text — are
 * inserted through raw SQL as labelled negative controls. They must diverge;
 * every other node must match in desired hash and render shape.
 *
 * Temporary: deleted together with the Python tree at the end of Phase 6.
 *
 * Usage: node scripts/hash_audit.mjs [--order ts-first|py-first|both]
 *        [--report .wrangler/audit-report.json] [--keep]
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORT_DEFAULT = join(ROOT, ".wrangler", "audit-report.json");
const HEALTH_TIMEOUT_MS = 240_000;
const HEALTH_POLL_MS = 1_500;
const DB_NAME = "lesserv";

const PLANES = {
  ts: { name: "ts", config: "wrangler.jsonc", port: 8787, inspectorPort: 9331 },
  py: {
    name: "py",
    config: "wrangler.reference.jsonc",
    port: 8788,
    inspectorPort: 9332,
  },
};

/** WHAT: the CLI flags, with defaults. */
const ORDER = argValue("--order", "both");
const REPORT_PATH = argValue("--report", REPORT_DEFAULT);
const KEEP_STATE = process.argv.includes("--keep");

if (!["both", "ts-first", "py-first"].includes(ORDER)) {
  throw new Error(`--order must be both, ts-first, or py-first (got "${ORDER}")`);
}

/** WHAT: read one `--flag value` pair from argv. */
function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

/**
 * WHAT: alpha's authored config — the realistic full-length case.
 *
 * WHY it looks like this: one REALITY inbound (key generation and injection),
 * one xhttp inbound (profiles and link labels), BLOCK plus two exits (outbound
 * order and generated routing rules), and an `x-audit` object carrying the
 * string/number surface canonical JSON is sensitive to: non-ASCII text, an
 * accented key, control characters, a fraction, an exponent-form float, and a
 * large float.
 */
function alphaConfig() {
  return {
    log: { loglevel: "warning", error: "" },
    inbounds: [
      {
        tag: "reality",
        listen: "0.0.0.0",
        port: 443,
        protocol: "vless",
        settings: { clients: [], decryption: "none", fallbacks: [] },
        streamSettings: {
          network: "raw",
          security: "reality",
          realitySettings: {
            show: false,
            dest: "www.apple.com:443",
            xver: 0,
            serverNames: ["www.apple.com", "apple.com"],
            privateKey: "operator-key",
            shortIds: ["", "0123456789abcdef"],
          },
        },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] },
      },
      {
        tag: "xhttp",
        listen: "0.0.0.0",
        port: 8443,
        protocol: "vless",
        settings: { clients: [], decryption: "none" },
        streamSettings: {
          network: "xhttp",
          security: "tls",
          tlsSettings: {
            serverName: "cdn.example.com",
            alpn: ["h2", "http/1.1"],
          },
          xhttpSettings: {
            path: "/lesserv",
            host: "cdn.example.com",
            mode: "auto",
          },
        },
      },
    ],
    outbounds: [
      {
        tag: "BLOCK",
        protocol: "blackhole",
        settings: { response: { type: "http" } },
      },
      {
        tag: "niigata",
        protocol: "shadowsocks",
        settings: {
          servers: [
            {
              address: "203.0.113.10",
              port: 8388,
              method: "aes-256-gcm",
              password: "secret",
            },
          ],
        },
      },
      {
        tag: "direct",
        protocol: "freedom",
        settings: { domainStrategy: "UseIP" },
      },
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [
        {
          type: "field",
          inboundTag: ["xhttp"],
          outboundTag: "niigata",
          ruleTag: "cdn-to-niigata",
        },
        { type: "field", user: ["regexp:.*@niigata$"], outboundTag: "niigata" },
        { type: "field", domain: ["geosite:private"], outboundTag: "direct" },
      ],
    },
    "x-audit": {
      notes: "Zürich — 東京 🚀",
      contrôle: "accented key",
      "line\nbreak": "tab\tand \u0007 bell",
      ratio: 0.5,
      tiny: 1e-5,
      huge: 1e21,
      truthy: true,
      nothing: null,
      empty: {},
      emptyList: [],
    },
  };
}

/**
 * WHAT: beta's authored config — the key-ordering case.
 *
 * WHY: canonical JSON sorts object keys by code point, and JS's default sort
 * disagrees with Python exactly when an astral key and a high BMP key share a
 * prefix (`"\uFFFD"` sorts before `"😀"` in Python, after it in UTF-16). The
 * `x-audit` keys put that pair in one object, alongside an empty key and an
 * accented one.
 */
function betaConfig() {
  return {
    inbounds: [
      {
        tag: "vless",
        port: 8443,
        protocol: "vless",
        settings: { clients: [], decryption: "none" },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            serverNames: ["www.cloudflare.com"],
            privateKey: "operator-key",
            shortIds: ["abcd"],
          },
        },
      },
    ],
    outbounds: [
      { tag: "BLOCK", protocol: "blackhole" },
      { tag: "almaty", protocol: "freedom" },
    ],
    routing: {
      rules: [
        {
          type: "field",
          user: ["alice@almaty", "regexp:.*@almaty$"],
          outboundTag: "almaty",
        },
      ],
    },
    "x-audit": {
      "😀": "astral",
      "\uFFFD": "replacement",
      é: "e-acute",
      a: 1,
      "": "empty key",
    },
  };
}

/** WHAT: the config skeleton the two raw negative-control nodes share. */
const RAW_SKELETON = `{
  "inbounds": [
    {
      "tag": "reality",
      "protocol": "vless",
      "port": 443,
      "settings": {"clients": []},
      "streamSettings": {
        "network": "raw",
        "security": "reality",
        "realitySettings": {
          "serverNames": ["apple.com"],
          "privateKey": "operator-key",
          "shortIds": ["1234"]
        }
      }
    }
  ],
  "outbounds": [
    {"tag": "BLOCK", "protocol": "blackhole"},
    {"tag": "niigata", "protocol": "freedom"}
  ],
  "routing": {"rules": []},
  "x-audit": {%AUDIT%}
}`;

/** WHAT: a raw node config with the audit object filled in verbatim. */
function rawConfig(auditText) {
  // The braces around the placeholder are real object braces; only the
  // %AUDIT% token is replaced.
  return RAW_SKELETON.replace("%AUDIT%", auditText);
}

/**
 * WHAT: the dataset both planes render.
 *
 * WHY rawNodes go through SQL: `100.0` and `9007199254740993` cannot survive
 * a JS literal or `JSON.stringify`, and the point of these nodes is the exact
 * stored text. The HTTP-seeded nodes exercise the ordinary admin path.
 */
function auditDataset() {
  return {
    nodes: [
      {
        id: "alpha",
        label: "Alpha · Zürich 🚀",
        address: "alpha.example.com",
        config: alphaConfig(),
      },
      {
        id: "beta",
        label: "Beta",
        address: "beta.example.com",
        config: betaConfig(),
      },
      { id: "gamma", label: "Gamma (no config)", address: "" },
      {
        id: "delta",
        label: "Delta (malformed)",
        address: "",
        config: { inbounds: "oops" },
      },
    ],
    rawNodes: [
      {
        id: "epsilon",
        label: "Epsilon (whole-number floats)",
        configText: rawConfig(
          `"whole": 100.0, "exponent": 1e2, "twodecimal": 1.50, "negzero": -0.0`,
        ),
      },
      {
        id: "zeta",
        label: "Zeta (oversized integers)",
        configText: rawConfig(
          `"big": 9007199254740993, "bigger": 18446744073709551615, ` +
            `"tiny": 1e-5, "mid": 1.5, "huge": 1e20`,
        ),
      },
    ],
    users: [
      {
        username: "alice",
        note: "Zürich team 🚀",
        access: {
          alpha: {
            allowed_inbounds: ["reality", "xhttp"],
            allowed_outbounds: ["niigata", "direct"],
          },
          beta: { allowed_inbounds: ["vless"], allowed_outbounds: ["almaty"] },
        },
      },
      {
        username: "bob",
        status: "disabled",
        access: {
          alpha: { allowed_inbounds: ["reality"], allowed_outbounds: ["niigata"] },
        },
      },
      {
        username: "carol",
        access: {
          gamma: {
            allowed_inbounds: ["reality"],
            allowed_outbounds: ["niigata"],
          },
        },
      },
      {
        username: "dave",
        access: {
          alpha: { allowed_inbounds: ["reality"], allowed_outbounds: [] },
        },
      },
    ],
    profiles: [
      {
        node: "alpha",
        payload: {
          id: "cdn",
          inbound_tag: "xhttp",
          label: "CDN view",
          overrides: {
            address: "cdn.example.com",
            host: "cdn.example.com",
            sni: "cdn.example.com",
            path: "/lesserv",
            port: 443,
          },
        },
      },
    ],
    // The known divergence classes; excluded from the gate and reported as
    // controls (the audit must be able to see a divergence when one exists).
    knownLimit: ["epsilon", "zeta"],
    // The malformed node's warning text is deliberately restated in TS
    // (TS-REWRITE-PLAN.md, TS4 finding), so warnings are informational there.
    warningTextMayDiffer: ["delta"],
    linkUsers: ["alice", "bob", "carol"],
  };
}

// ---------------------------------------------------------------------------
// Process and HTTP helpers
// ---------------------------------------------------------------------------

/** WHAT: make a directory, removing any previous state. */
function resetDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

/** WHAT: run one command to completion and fail loudly on a non-zero exit. */
function run(command) {
  const result = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed (${result.status}): ${command}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

/** WHAT: the dev-server command line for one plane. */
function planeCommand(plane, persistDir) {
  const base =
    plane.name === "ts"
      ? "npx wrangler dev"
      : "uv run pywrangler dev";
  return (
    `${base} --config ${plane.config} --persist-to "${persistDir}" ` +
    `--port ${plane.port} --inspector-port ${plane.inspectorPort}`
  );
}

/** WHAT: start a plane, run `steps`, and always stop the process tree. */
async function withPlane(plane, persistDir, steps) {
  const child = spawn(planeCommand(plane, persistDir), {
    cwd: ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const bootMs = await waitForHealth(plane.port);
    const result = await steps(`http://127.0.0.1:${plane.port}`);
    return { ...result, boot_ms: bootMs };
  } finally {
    killTree(child);
    writeFileSync(
      join(ROOT, ".wrangler", `audit-${plane.name}.log`),
      output,
    );
    await waitForPortFree(plane.port);
  }
}

/** WHAT: poll `/api/health` until the plane answers; return elapsed ms. */
async function waitForHealth(port) {
  const started = Date.now();
  while (Date.now() - started < HEALTH_TIMEOUT_MS) {
    if (await healthOk(port)) {
      return Date.now() - started;
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(`plane on port ${port} never became healthy`);
}

/** WHAT: true when the plane's health endpoint answers 200. */
async function healthOk(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(4_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** WHAT: wait until a killed plane's port stops answering or refuses. */
async function waitForPortFree(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await healthOk(port))) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`port ${port} stayed occupied after killing the plane`);
}

/** WHAT: stop a dev-server process tree (wrangler spawns workerd children). */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** WHAT: sleep for one small poll interval. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WHAT: one HTTP request with optional JSON body; status, parsed JSON, and
 * wall-clock duration.
 *
 * WHY wall-clock: a local dev-mode proxy for the request-cost comparison —
 * honest about being a proxy (no workerd CPU metric is available locally).
 */
async function request(base, method, path, options = {}) {
  const started = Date.now();
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    json,
    text,
    ms: Date.now() - started,
  };
}

/** WHAT: fail when a seeding request did not do what the audit needs. */
function expect(response, status, what) {
  if (response.status !== status) {
    throw new Error(
      `${what}: expected ${status}, got ${response.status}: ${response.text}`,
    );
  }
  return response.json;
}

// ---------------------------------------------------------------------------
// Seeding and collection
// ---------------------------------------------------------------------------

/** WHAT: create every node, config, user, and profile through the admin API. */
async function seed(base, dataset) {
  for (const node of dataset.nodes) {
    const body = { id: node.id, label: node.label, address: node.address };
    expect(
      await request(base, "POST", "/api/admin/nodes", { body }),
      201,
      `create node ${node.id}`,
    );
    if (node.config !== undefined) {
      expect(
        await request(base, "PUT", `/api/admin/nodes/${node.id}/config`, {
          body: node.config,
        }),
        200,
        `config for ${node.id}`,
      );
    }
  }
  for (const user of dataset.users) {
    expect(
      await request(base, "POST", "/api/admin/users", { body: user }),
      201,
      `create user ${user.username}`,
    );
  }
  for (const profile of dataset.profiles) {
    expect(
      await request(
        base,
        "POST",
        `/api/admin/nodes/${profile.node}/link-profiles`,
        { body: profile.payload },
      ),
      201,
      `profile for ${profile.node}`,
    );
  }
}

/** WHAT: mint a token for every config-bearing node on the seeding plane. */
async function mintTokens(base, dataset, tokens) {
  for (const node of [...dataset.nodes, ...dataset.rawNodes]) {
    const hasConfig =
      node.config !== undefined || node.configText !== undefined;
    if (!hasConfig) {
      continue;
    }
    const minted = expect(
      await request(base, "POST", `/api/admin/nodes/${node.id}/token`),
      201,
      `token for ${node.id}`,
    );
    tokens[node.id] = minted.token;
  }
}

/**
 * WHAT: capture everything the audit compares for every node, plus share
 * links for the link users.
 *
 * WHY the node `/config` fetch with a minted token: it is the artifact the
 * agent actually applies, and the token was minted by the other plane in the
 * second pass — so a token-hash divergence fails here too.
 */
async function collect(base, dataset, tokens) {
  const nodes = {};
  const requests = [];
  for (const spec of [...dataset.nodes, ...dataset.rawNodes]) {
    const id = spec.id;
    const sync = await request(base, "GET", `/api/admin/nodes/${id}/sync`);
    requests.push({ label: `sync:${id}`, ms: sync.ms });
    const runtime = await request(
      base,
      "GET",
      `/api/admin/nodes/${id}/config/runtime`,
    );
    requests.push({ label: `runtime:${id}`, ms: runtime.ms });
    const entry = {
      sync_status: sync.status,
      desired_hash: sync.json?.desired_hash ?? null,
      runtime_status: runtime.status,
      runtime_hash: runtime.json?.hash ?? null,
      runtime_warnings: runtime.json?.warnings ?? null,
      runtime_config: runtime.json?.config ?? null,
      config_status: null,
      config_hash: null,
    };
    if (entry.desired_hash !== null && tokens[id] !== undefined) {
      const fetched = await request(
        base,
        "GET",
        `/api/node/config?hash=${entry.desired_hash}`,
        { headers: authHeaders(tokens[id], id) },
      );
      requests.push({ label: `config:${id}`, ms: fetched.ms });
      entry.config_status = fetched.status;
      entry.config_hash = fetched.json?.hash ?? null;
    }
    nodes[id] = entry;
  }
  const links = {};
  for (const username of dataset.linkUsers) {
    const response = await request(
      base,
      "GET",
      `/api/admin/users/${username}/links`,
    );
    requests.push({ label: `links:${username}`, ms: response.ms });
    links[username] = {
      status: response.status,
      body: response.json,
    };
  }
  return { nodes, links, requests };
}

/** WHAT: bearer headers one node's agent sends. */
function authHeaders(token, nodeId) {
  return { Authorization: `Bearer ${token}`, "X-Lesserv-Node": nodeId };
}

/** WHAT: structural JSON equality that ignores key order. */
function stable(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// The audit itself
// ---------------------------------------------------------------------------

/**
 * WHAT: apply migrations, insert the raw negative controls, then run both
 * planes over that state in the requested order.
 */
async function auditOrder(order) {
  const dataset = auditDataset();
  const persistDir = join(ROOT, ".wrangler", `audit-state-${order}`);
  resetDir(persistDir);

  run(
    `npx wrangler d1 migrations apply ${DB_NAME} --local ` +
      `--persist-to "${persistDir}" --config wrangler.jsonc`,
  );
  applyRawNodes(persistDir, dataset);

  const first = order === "ts-first" ? PLANES.ts : PLANES.py;
  const second = order === "ts-first" ? PLANES.py : PLANES.ts;
  const tokens = {};

  const firstPass = await withPlane(first, persistDir, async (base) => {
    await seed(base, dataset);
    await mintTokens(base, dataset, tokens);
    return collect(base, dataset, tokens);
  });
  const secondPass = await withPlane(second, persistDir, (base) =>
    collect(base, dataset, tokens),
  );

  const result = {
    order,
    seed_plane: first.name,
    first_plane: first.name,
    second_plane: second.name,
    boot_ms: {
      [first.name]: firstPass.boot_ms,
      [second.name]: secondPass.boot_ms,
    },
    timings: {
      [first.name]: summarize(firstPass.requests),
      [second.name]: summarize(secondPass.requests),
    },
    nodes: compareNodes(dataset, {
      [first.name]: firstPass.nodes,
      [second.name]: secondPass.nodes,
    }),
    links: compareLinks(dataset, {
      [first.name]: firstPass.links,
      [second.name]: secondPass.links,
    }),
  };
  result.gate = gateOf(result, dataset);
  if (!KEEP_STATE) {
    rmSync(persistDir, { recursive: true, force: true });
  }
  return result;
}

/** WHAT: insert the raw negative-control nodes through SQL, verbatim. */
function applyRawNodes(persistDir, dataset) {
  const now = Math.floor(Date.now() / 1000);
  const statements = dataset.rawNodes.map(
    (node) =>
      `INSERT INTO nodes (id, label, address, config_json, created_at) ` +
      `VALUES ('${sqlText(node.id)}', '${sqlText(node.label)}', '', ` +
      `'${sqlText(node.configText)}', ${now});`,
  );
  const file = join(ROOT, ".wrangler", "audit-raw-nodes.sql");
  writeFileSync(file, statements.join("\n") + "\n");
  run(
    `npx wrangler d1 execute ${DB_NAME} --local ` +
      `--persist-to "${persistDir}" --config wrangler.jsonc --file "${file}"`,
  );
}

/** WHAT: escape one string for a single-quoted SQL literal. */
function sqlText(text) {
  return text.replaceAll("'", "''");
}

/** WHAT: compare one node's captures across the two planes. */
function compareNodes(dataset, byPlane) {
  const [firstName, secondName] = Object.keys(byPlane);
  const ids = [...dataset.nodes, ...dataset.rawNodes].map((node) => node.id);
  return ids.map((id) => {
    const first = byPlane[firstName][id];
    const second = byPlane[secondName][id];
    const kind = dataset.knownLimit.includes(id)
      ? "known-limit"
      : "parity";
    return {
      id,
      kind,
      [firstName]: first,
      [secondName]: second,
      desired_hash_equal: first.desired_hash === second.desired_hash,
      runtime_status_equal: first.runtime_status === second.runtime_status,
      runtime_hash_equal: first.runtime_hash === second.runtime_hash,
      runtime_config_equal:
        stable(first.runtime_config) === stable(second.runtime_config),
      warnings_equal:
        stable(first.runtime_warnings) === stable(second.runtime_warnings),
      config_status_equal: first.config_status === second.config_status,
      config_hash_equal: first.config_hash === second.config_hash,
    };
  });
}

/** WHAT: compare one user's link list across the two planes. */
function compareLinks(dataset, byPlane) {
  const [firstName, secondName] = Object.keys(byPlane);
  return dataset.linkUsers.map((username) => {
    const first = byPlane[firstName][username];
    const second = byPlane[secondName][username];
    return {
      username,
      [firstName]: first,
      [secondName]: second,
      status_equal: first.status === second.status,
      body_equal: stable(first.body) === stable(second.body),
    };
  });
}

/**
 * WHAT: decide whether the order passed.
 *
 * WHY known-limit nodes are excluded but still reported: they exist to prove
 * the audit detects the documented divergence classes; the gate is about the
 * parity nodes. The malformed node's warning text is restated in TS and is
 * informational (TS4 finding).
 */
function gateOf(result, dataset) {
  const failures = [];
  for (const node of result.nodes) {
    if (node.kind === "known-limit") {
      continue;
    }
    for (const flag of [
      "desired_hash_equal",
      "runtime_status_equal",
      "runtime_hash_equal",
      "runtime_config_equal",
      "config_status_equal",
      "config_hash_equal",
    ]) {
      if (!node[flag]) {
        failures.push(`${node.id}: ${flag}`);
      }
    }
    if (
      !dataset.warningTextMayDiffer.includes(node.id) &&
      !node.warnings_equal
    ) {
      failures.push(`${node.id}: warnings_equal`);
    }
  }
  for (const link of result.links) {
    if (!link.status_equal || !link.body_equal) {
      failures.push(`links:${link.username}`);
    }
  }
  return {
    passed: failures.length === 0,
    failures,
    parity_nodes: result.nodes.filter((node) => node.kind === "parity").length,
    known_limit_nodes: result.nodes
      .filter((node) => node.kind === "known-limit")
      .map((node) => ({
        id: node.id,
        divergence_observed: !node.desired_hash_equal,
      })),
  };
}

/** WHAT: mean/median/max of one plane's request timings, grouped by kind. */
function summarize(requests) {
  const groups = new Map();
  for (const entry of requests) {
    const kind = entry.label.split(":")[0];
    if (!groups.has(kind)) {
      groups.set(kind, []);
    }
    groups.get(kind).push(entry.ms);
  }
  const summary = {};
  for (const [kind, values] of groups) {
    const sorted = [...values].sort((left, right) => left - right);
    summary[kind] = {
      count: values.length,
      mean_ms: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      median_ms: sorted[Math.floor(sorted.length / 2)],
      max_ms: sorted[sorted.length - 1],
    };
  }
  return summary;
}

/** WHAT: round to one decimal for readable reports. */
function round(value) {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const orders = ORDER === "both" ? ["ts-first", "py-first"] : [ORDER];
const report = {
  generated_at: new Date().toISOString(),
  commit: run("git rev-parse HEAD").trim(),
  database: "seeded local D1 (no production copy exists)",
  orders: {},
};

for (const order of orders) {
  console.log(`\n=== hash audit: ${order} ===`);
  const result = await auditOrder(order);
  report.orders[order] = result;
  for (const node of result.nodes) {
    const mark = node.kind === "known-limit"
      ? node.desired_hash_equal
        ? "MATCH (control did not diverge)"
        : "DIVERGES (control, expected)"
      : node.desired_hash_equal
        ? "equal"
        : "DIVERGENT";
    console.log(`  ${node.id.padEnd(8)} ${node.kind.padEnd(12)} ${mark}`);
  }
  console.log(
    `  gate: ${result.gate.passed ? "PASS" : "FAIL " + result.gate.failures.join(", ")}`,
  );
}

report.gate = {
  passed: orders.every((order) => report.orders[order].gate.passed),
  failures: orders.flatMap((order) =>
    report.orders[order].gate.failures.map((failure) => `${order}: ${failure}`),
  ),
};

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
console.log(`\nreport: ${REPORT_PATH}`);
console.log(`\nGATE: ${report.gate.passed ? "PASS" : "FAIL"}`);
process.exit(report.gate.passed ? 0 : 1);
