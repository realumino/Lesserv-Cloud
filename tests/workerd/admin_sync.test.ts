/**
 * Tests for token minting and the admin drift view, over a real plane.
 *
 * Ported from tests/workerd/test_admin_sync.py with its assertions intact.
 * WHY HTTP: mint-once semantics (plaintext never stored) and the
 * desired-vs-applied sync shape are the admin half of the M3 contract —
 * status codes and shapes, pinned against a live plane and D1.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { NodeOut, NodeSyncOut } from "../../src/models";
import { planeJson, uid } from "../helpers";

/** WHAT: a minimal authored config with one inbound and one exit. */
function config(): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "reality",
        protocol: "vless",
        port: 443,
        settings: { clients: [] },
      },
    ],
    outbounds: [{ tag: "niigata", protocol: "freedom" }],
  };
}

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("minting and the drift view", () => {
  let node: string;

  beforeEach(async () => {
    node = uid("n");
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Tokyo 01",
      address: "funky.example.com",
    });
    expect(response.status, await response.clone().text()).toBe(201);
  });

  /** WHAT: mint a token via the API and return the plaintext. */
  async function mint(nodeId: string = node): Promise<string> {
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${nodeId}/token`,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return (await body<{ token: string }>(response)).token;
  }

  /** WHAT: headers one node sends on every request. */
  function auth(token: string, nodeId: string = node): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "X-Lesserv-Node": nodeId,
    };
  }

  /** WHAT: GET one node's drift view. */
  async function sync(nodeId: string = node): Promise<NodeSyncOut> {
    return body<NodeSyncOut>(
      await planeJson("GET", `/api/admin/nodes/${nodeId}/sync`),
    );
  }

  it("returns the plaintext once with no-store", async () => {
    const response = await planeJson("POST", `/api/admin/nodes/${node}/token`);

    expect(response.status).toBe(201);
    const created = await body<{
      node_id: string;
      token: string;
      created_at: number;
    }>(response);
    expect(created.node_id).toBe(node);
    expect(created.token).toBeTruthy();
    expect(created.created_at).toBeGreaterThan(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never stores the plaintext", async () => {
    const token = await mint();

    const stored = await body<NodeOut>(
      await planeJson("GET", `/api/admin/nodes/${node}`),
    );

    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("shows pending before the first contact", async () => {
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());

    const state = await sync();

    expect(state.state).toBe("pending");
    expect(state.desired_hash).toBeTruthy();
    expect(state.applied_hash).toBeNull();
    expect(state.in_sync).toBe(false);
    expect(state.last_seen).toBeNull();
  });

  it("shows a null desired hash without a config", async () => {
    const state = await sync();

    expect(state.desired_hash).toBeNull();
    expect(state.in_sync).toBe(false);
  });

  it("converges after a fake-agent apply", async () => {
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());
    const token = await mint();
    const headers = auth(token);
    const wanted = (
      await body<{ desired_hash: string }>(
        await planeJson("POST", "/api/node/heartbeat", { protocol: 1 }, headers),
      )
    ).desired_hash;
    await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 1, hash: wanted, ok: true, stage: "applied" },
      headers,
    );

    const state = await sync();

    expect(state.state).toBe("active");
    expect(state.desired_hash).toBe(wanted);
    expect(state.applied_hash).toBe(wanted);
    expect(state.in_sync).toBe(true);
    expect(state.last_seen).not.toBeNull();
  });

  it("shows a failure without hiding drift", async () => {
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());
    const token = await mint();
    const headers = auth(token);
    const wanted = (
      await body<{ desired_hash: string }>(
        await planeJson("POST", "/api/node/heartbeat", { protocol: 1 }, headers),
      )
    ).desired_hash;
    await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 1, hash: "bad", ok: false, stage: "started", error: "boom" },
      headers,
    );

    const state = await sync();

    expect(state.desired_hash).toBe(wanted);
    expect(state.applied_hash).toBeNull();
    expect(state.in_sync).toBe(false);
    expect(state.last_error).toBe("boom");
    expect(state.health).toBe("error:started");
  });

  it("404s sync for an unknown node", async () => {
    const response = await planeJson("GET", "/api/admin/nodes/ghost/sync");

    expect(response.status).toBe(404);
  });
});
