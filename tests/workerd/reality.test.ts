/**
 * REALITY key behavior over the admin API and the sealed-at-rest check.
 *
 * Ported from tests/workerd/test_reality.py with its assertions intact.
 * Generation, per-node scoping, and rotation are observable through the
 * reality endpoints; "sealed at rest" is the one invariant that lives in
 * the database, so it is asserted with one `env.DB` read. The private key
 * never appears in any API response — only derived public keys.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { planeJson, uid } from "../helpers";

/** WHAT: one REALITY inbound and one plain one — the minimum the router needs. */
function realityConfig(): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "REALITY",
        protocol: "vless",
        settings: { clients: [] },
        streamSettings: {
          network: "raw",
          security: "reality",
          realitySettings: { privateKey: "x" },
        },
      },
      { tag: "PLAIN", protocol: "vless", settings: { clients: [] } },
    ],
    outbounds: [],
  };
}

/** WHAT: a config with no REALITY inbound at all. */
function plainConfig(): Record<string, unknown> {
  return {
    inbounds: [
      { tag: "PLAIN", protocol: "vless", settings: { clients: [] } },
    ],
    outbounds: [],
  };
}

/** WHAT: one row of the reality key table (only the parts tests read). */
type KeyOut = { inbound: string; public_key: string | null; created_at: number | null };

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the reality API", () => {
  /** WHAT: create the test's node and return its id. */
  async function makeNode(): Promise<string> {
    const node = uid("n");
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "n",
      address: "",
    });
    expect(response.status).toBe(201);
    return node;
  }

  /** WHAT: paste one node's config, asserting it saved. */
  async function putConfig(
    nodeId: string,
    nodeConfig: Record<string, unknown>,
  ): Promise<void> {
    const put = await planeJson(
      "PUT",
      `/api/admin/nodes/${nodeId}/config`,
      nodeConfig,
    );
    expect(put.status, await put.clone().text()).toBe(200);
  }

  /** WHAT: trigger key generation through the runtime render choke point. */
  async function ensureKeys(nodeId: string): Promise<void> {
    const runtime = await planeJson(
      "GET",
      `/api/admin/nodes/${nodeId}/config/runtime`,
    );
    expect(runtime.status, await runtime.clone().text()).toBe(200);
  }

  /** WHAT: GET one node's key list. */
  async function keys(nodeId: string): Promise<KeyOut[]> {
    const response = await planeJson("GET", `/api/admin/nodes/${nodeId}/reality`);
    return (await body<{ keys: KeyOut[] }>(response)).keys;
  }

  it("returns an envelope with a null public key", async () => {
    const node = await makeNode();
    await putConfig(node, realityConfig());

    const list = await keys(node);

    expect(list[0]!.inbound).toBe("REALITY");
    expect(list[0]!.public_key).toBeNull();
  });

  it("404s for a ghost and a configless node", async () => {
    const node = await makeNode();
    const ghost = await planeJson("GET", "/api/admin/nodes/ghost/reality");
    expect(ghost.status).toBe(404);

    const response = await planeJson("GET", `/api/admin/nodes/${node}/reality`);
    expect(response.status).toBe(404);
  });

  it("rotates every REALITY inbound at once", async () => {
    const node = await makeNode();
    await putConfig(node, realityConfig());
    await ensureKeys(node);
    const before = await keys(node);

    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/reality/rotate`,
    );
    expect(await response.json()).toEqual({ rotated: ["REALITY"] });
    const after = await keys(node);
    expect(after[0]!.public_key).not.toBe(before[0]!.public_key);
  });

  it("404s rotate-all when there is no REALITY inbound", async () => {
    const node = await makeNode();
    await putConfig(node, plainConfig());

    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/reality/rotate`,
    );
    expect(response.status).toBe(404);
  });

  it("rotate-one returns the new public key", async () => {
    const node = await makeNode();
    await putConfig(node, realityConfig());

    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/reality/REALITY/rotate`,
    );
    const result = await body<{ inbound: string; public_key: string }>(response);

    expect(result.inbound).toBe("REALITY");
    expect(result.public_key).not.toBeNull();
  });

  it("404s rotate-one for unknown and non-reality tags", async () => {
    const node = await makeNode();
    await putConfig(node, realityConfig());

    for (const tag of ["NOPE", "PLAIN"]) {
      const response = await planeJson(
        "POST",
        `/api/admin/nodes/${node}/reality/${tag}/rotate`,
      );
      expect(response.status, tag).toBe(404);
    }
  });

  it("scopes keys per node for the same tag", async () => {
    const node = await makeNode();
    const other = await makeNode();
    await putConfig(other, realityConfig());
    await putConfig(node, realityConfig());
    await ensureKeys(other);
    await ensureKeys(node);

    const mine = await keys(node);
    const theirs = await keys(other);

    expect(mine[0]!.public_key).not.toBe(theirs[0]!.public_key);
  });

  it("never returns the private key from the API", async () => {
    const node = await makeNode();
    await putConfig(node, realityConfig());
    await ensureKeys(node);

    const response = await planeJson("GET", `/api/admin/nodes/${node}/reality`);
    expect(JSON.stringify(await response.json())).not.toContain("privateKey");
  });

  it("stores keys sealed at rest", async () => {
    const node = await makeNode();
    await putConfig(node, realityConfig());
    await ensureKeys(node);

    const result = await env.DB.prepare(
      "SELECT substr(private_key, 1, 3) AS prefix FROM reality_keys " +
        "WHERE node_id = ?",
    )
      .bind(node)
      .all<{ prefix: string }>();

    expect(result.results.length).toBeGreaterThan(0);
    for (const row of result.results) {
      expect(row.prefix).toBe("v1:");
    }
  });
});
