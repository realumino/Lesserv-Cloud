/**
 * Two nodes on one plane: independent convergence and total isolation.
 *
 * Ported from tests/workerd/test_two_nodes.py with its assertions intact.
 * WHY this file exists: M5's headline claim is that adding node #2 requires
 * no code change anywhere — the node dimension was general from M1. That
 * claim is only credible if a second node, built with the same calls as the
 * first, converges on its own render and can never see the other's data.
 * The fake agents here are the same HTTP loop the real agent runs; the
 * plane cannot tell them apart.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { NodeSyncOut } from "../../src/models";
import { planeJson, uid } from "../helpers";

/**
 * WHAT: an authored config with one REALITY inbound and one named exit.
 *
 * WHY the exit tag is a parameter: two nodes with different exits prove the
 * qualified names (`{node}-{exit}`) are per node, not shared.
 */
function config(exitTag: string): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "reality",
        protocol: "vless",
        port: 443,
        settings: { clients: [] },
        streamSettings: {
          network: "raw",
          security: "reality",
          realitySettings: {
            serverNames: ["apple.com"],
            privateKey: "operator-key",
            shortIds: ["1234"],
          },
        },
      },
    ],
    outbounds: [{ tag: exitTag, protocol: "freedom" }],
  };
}

/** WHAT: the rendered pieces the two-node assertions read. */
type Runtime = {
  inbounds: {
    settings: { clients: { email: string }[] };
    streamSettings: { realitySettings: { privateKey: string } };
  }[];
};

/** WHAT: every client email across all inbounds of one rendered config. */
function clientEmails(runtime: Runtime): string[] {
  const emails: string[] = [];
  for (const inbound of runtime.inbounds) {
    for (const entry of inbound.settings.clients) {
      emails.push(entry.email);
    }
  }
  return emails;
}

/**
 * WHAT: the injected REALITY private key of one rendered config.
 *
 * WHY this reads the render and not the database: the panel-owned key only
 * becomes visible to a node through the render, and that is the artifact
 * the isolation claim is about.
 */
function privateKey(runtime: Runtime): string {
  return runtime.inbounds[0]!.streamSettings.realitySettings.privateKey;
}

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("one plane, two nodes, two fake agents", () => {
  let nodeA: string;
  let nodeB: string;

  beforeEach(() => {
    nodeA = uid("a");
    nodeB = uid("b");
  });

  /** WHAT: create a node and paste its authored config (generic calls). */
  async function makeNode(
    nodeId: string,
    exitTag: string,
    address = "funky.example.com",
  ): Promise<void> {
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: nodeId,
      label: `Node ${nodeId}`,
      address,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const put = await planeJson(
      "PUT",
      `/api/admin/nodes/${nodeId}/config`,
      config(exitTag),
    );
    expect(put.status, await put.clone().text()).toBe(200);
  }

  /** WHAT: mint one node's bearer token and return the plaintext. */
  async function mint(nodeId: string): Promise<string> {
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${nodeId}/token`,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return (await body<{ token: string }>(response)).token;
  }

  /** WHAT: headers one node sends on every request. */
  function auth(token: string, nodeId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "X-Lesserv-Node": nodeId,
    };
  }

  /** WHAT: poll once; return the desired hash the plane named. */
  async function heartbeat(
    token: string,
    nodeId: string,
    applied: string | null = null,
  ): Promise<string | null> {
    const response = await planeJson(
      "POST",
      "/api/node/heartbeat",
      { protocol: 1, applied_hash: applied },
      auth(token, nodeId),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return (await body<{ desired_hash: string | null }>(response)).desired_hash;
  }

  /** WHAT: fetch the exact render the heartbeat named, asserting its hash. */
  async function fetchConfig(
    token: string,
    nodeId: string,
    wanted: string | null,
  ): Promise<Runtime> {
    const response = await planeJson(
      "GET",
      `/api/node/config?hash=${wanted}`,
      undefined,
      auth(token, nodeId),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const fetched = await body<{ hash: string; config: Runtime }>(response);
    expect(fetched.hash).toBe(wanted);
    return fetched.config;
  }

  /** WHAT: report a successful apply of one hash. */
  async function report(
    token: string,
    nodeId: string,
    wanted: string | null,
  ): Promise<void> {
    const response = await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 1, hash: wanted, ok: true, stage: "applied" },
      auth(token, nodeId),
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** WHAT: read one node's drift view. */
  async function sync(nodeId: string): Promise<NodeSyncOut> {
    return body<NodeSyncOut>(
      await planeJson("GET", `/api/admin/nodes/${nodeId}/sync`),
    );
  }

  /** WHAT: create one user with the given per-node access map. */
  async function makeUser(
    username: string,
    access: Record<string, unknown>,
  ): Promise<void> {
    const response = await planeJson("POST", "/api/admin/users", {
      username,
      access,
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }

  it("converges two fake agents independently", async () => {
    const shared = uid("shared");
    const onlyA = uid("onlya");
    await makeNode(nodeA, "alpha");
    await makeNode(nodeB, "beta");
    await makeUser(shared, {
      [nodeA]: { allowed_inbounds: ["reality"], allowed_outbounds: ["alpha"] },
      [nodeB]: { allowed_inbounds: ["reality"], allowed_outbounds: ["beta"] },
    });
    await makeUser(onlyA, {
      [nodeA]: { allowed_inbounds: ["reality"], allowed_outbounds: ["alpha"] },
    });
    const tokenA = await mint(nodeA);
    const tokenB = await mint(nodeB);

    const wantedA = await heartbeat(tokenA, nodeA);
    const wantedB = await heartbeat(tokenB, nodeB);

    expect(wantedA).not.toBe(wantedB);
    const runtimeA = await fetchConfig(tokenA, nodeA, wantedA);
    const runtimeB = await fetchConfig(tokenB, nodeB, wantedB);
    const emailsA = clientEmails(runtimeA);
    const emailsB = clientEmails(runtimeB);
    expect(emailsA).toContain(`${shared}@${nodeA}-alpha`);
    expect(emailsA).toContain(`${onlyA}@${nodeA}-alpha`);
    expect(emailsB).toContain(`${shared}@${nodeB}-beta`);
    expect(emailsB.some((email) => email.startsWith(`${onlyA}@`))).toBe(false);
    expect(privateKey(runtimeA)).not.toBe(privateKey(runtimeB));

    await report(tokenA, nodeA, wantedA);
    expect((await sync(nodeA)).in_sync).toBe(true);
    const drifting = await sync(nodeB);
    expect(drifting.in_sync).toBe(false);
    expect(drifting.applied_hash).toBeNull();
    expect(drifting.desired_hash).toBe(wantedB);

    await report(tokenB, nodeB, wantedB);
    const settled = await sync(nodeB);
    expect(settled.in_sync).toBe(true);
    expect(settled.applied_hash).toBe(wantedB);
  });

  it("leaves the other hash unchanged on a user edit", async () => {
    await makeNode(nodeA, "alpha");
    await makeNode(nodeB, "beta");
    const tokenA = await mint(nodeA);
    const tokenB = await mint(nodeB);
    const beforeA = await heartbeat(tokenA, nodeA);
    const beforeB = await heartbeat(tokenB, nodeB);

    await makeUser(uid("alice"), {
      [nodeA]: { allowed_inbounds: ["reality"], allowed_outbounds: ["alpha"] },
    });

    expect(await heartbeat(tokenA, nodeA)).not.toBe(beforeA);
    expect(await heartbeat(tokenB, nodeB)).toBe(beforeB);
  });

  it("leaves the other hash unchanged on a config change", async () => {
    await makeNode(nodeA, "alpha");
    await makeNode(nodeB, "beta");
    const tokenA = await mint(nodeA);
    const tokenB = await mint(nodeB);
    const beforeA = await heartbeat(tokenA, nodeA);
    const beforeB = await heartbeat(tokenB, nodeB);

    const changed = await planeJson(
      "PUT",
      `/api/admin/nodes/${nodeB}/config`,
      config("gamma"),
    );
    expect(changed.status, await changed.clone().text()).toBe(200);

    expect(await heartbeat(tokenA, nodeA)).toBe(beforeA);
    expect(await heartbeat(tokenB, nodeB)).not.toBe(beforeB);
  });

  it("keeps cross-node reads at 401", async () => {
    // A valid token must never unlock another node's endpoints.
    await makeNode(nodeA, "alpha");
    await makeNode(nodeB, "beta");
    const tokenA = await mint(nodeA);

    const cases: [string, string, unknown][] = [
      ["POST", "/api/node/enroll", { protocol: 1 }],
      ["POST", "/api/node/heartbeat", { protocol: 1 }],
      ["GET", "/api/node/config", undefined],
      [
        "POST",
        "/api/node/report",
        { protocol: 1, hash: "x", ok: true, stage: "applied" },
      ],
    ];
    for (const [method, path, payload] of cases) {
      const response = await planeJson(
        method,
        path,
        payload,
        auth(tokenA, nodeB),
      );
      expect(response.status, path).toBe(401);
    }
  });
});
