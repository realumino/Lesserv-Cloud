/**
 * Tests for the PROTOCOL.md v1 pull contract, over a real plane.
 *
 * Ported from tests/workerd/test_node_protocol.py with its assertions
 * intact. WHY HTTP: authentication, status codes, and the heartbeat →
 * config → report convergence loop are the cross-repo contract — exactly
 * what an HTTP test pins. The fake-agent flow here (enroll, poll, fetch,
 * apply, report) is the same loop the Lesserv-Agent repo runs for real; the
 * plane cannot tell them apart. Node state is read through the admin /sync
 * view instead of raw rows.
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

/** WHAT: one enroll response as the endpoint returns it. */
type EnrollOut = {
  id: string;
  label: string;
  address: string;
  state: string;
  desired_hash: string | null;
};

/** WHAT: one heartbeat response as the endpoint returns it. */
type HeartbeatOut = { desired_hash: string | null; actions: unknown[] };

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the node protocol", () => {
  let node: string;

  beforeEach(() => {
    node = uid("n");
  });

  /** WHAT: create a node via the API; optionally paste its config. */
  async function makeNode(
    nodeId: string = node,
    nodeConfig?: Record<string, unknown>,
  ): Promise<void> {
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: nodeId,
      label: "Node",
      address: "funky.example.com",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    if (nodeConfig !== undefined) {
      const put = await planeJson(
        "PUT",
        `/api/admin/nodes/${nodeId}/config`,
        nodeConfig,
      );
      expect(put.status, await put.clone().text()).toBe(200);
    }
  }

  /** WHAT: mint a token via the API and return the plaintext. */
  async function mint(nodeId: string = node): Promise<string> {
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${nodeId}/token`,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const created = await body<{ node_id: string; token: string }>(response);
    expect(created.node_id).toBe(nodeId);
    expect(created.token).toBeTruthy();
    return created.token;
  }

  /** WHAT: headers one node sends on every request. */
  function auth(token: string, nodeId: string = node): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "X-Lesserv-Node": nodeId,
    };
  }

  /** WHAT: GET one node's state through the admin drift view. */
  async function sync(nodeId: string = node): Promise<NodeSyncOut> {
    return body<NodeSyncOut>(
      await planeJson("GET", `/api/admin/nodes/${nodeId}/sync`),
    );
  }

  it("404s minting a token for an unknown node", async () => {
    const response = await planeJson("POST", "/api/admin/nodes/ghost/token");

    expect(response.status).toBe(404);
  });

  it("rotates on mint and kills the old token", async () => {
    await makeNode();
    const first = await mint();

    const enrolled = await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1 },
      auth(first),
    );
    expect(enrolled.status).toBe(200);
    const second = await mint();

    expect(second).not.toBe(first);
    const stale = await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1 },
      auth(first),
    );
    expect(stale.status).toBe(401);
    const fresh = await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1 },
      auth(second),
    );
    expect(fresh.status).toBe(200);
  });

  it("rejects bad credentials on enroll", async () => {
    await makeNode();
    const token = await mint();

    const cases: [Record<string, string>, string][] = [
      [{}, "no headers at all"],
      [{ Authorization: `Bearer ${token}` }, "no node header"],
      [{ "X-Lesserv-Node": node }, "no bearer token"],
      [auth("wrong"), "wrong token"],
      [auth(token, "ghost"), "unknown node id"],
    ];
    for (const [headers, label] of cases) {
      const response = await planeJson(
        "POST",
        "/api/node/enroll",
        { protocol: 1 },
        headers,
      );
      expect(response.status, label).toBe(401);
    }
  });

  it("never lets a node read another node", async () => {
    // The one invariant that deserves an explicit test (PROTOCOL.md).
    const other = uid("n");
    await makeNode(node, config());
    await makeNode(other, config());
    const tokenA = await mint(node);

    const cases: [string, string, unknown][] = [
      ["POST", "/api/node/enroll", { protocol: 1 }],
      ["POST", "/api/node/heartbeat", { protocol: 1 }],
      ["GET", "/api/node/config", undefined],
      [
        "POST",
        "/api/node/report",
        { protocol: 1, hash: "x", ok: true, stage: "applied" },
      ],
      ["POST", "/api/node/stats", { protocol: 1, boot_id: "b", counters: {} }],
    ];
    for (const [method, path, payload] of cases) {
      const response = await planeJson(
        method,
        path,
        payload,
        auth(tokenA, other),
      );
      expect(response.status, path).toBe(401);
    }
  });

  it("returns metadata and the desired hash on enroll", async () => {
    await makeNode(node, config());
    const token = await mint();

    const first = await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1, agent_version: "0.1.0", xray_version: "25.1.1" },
      auth(token),
    );

    expect(first.status).toBe(200);
    const enrolled = await body<EnrollOut>(first);
    expect(enrolled.state).toBe("active");
    expect(enrolled.id).toBe(node);
    expect(enrolled.desired_hash).toBeTruthy();
    const second = await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1 },
      auth(token),
    );
    expect(second.status).toBe(200);
    expect((await body<EnrollOut>(second)).desired_hash).toBe(
      enrolled.desired_hash,
    );
    const state = await sync();
    expect(state.agent_version).toBe("0.1.0");
    expect(state.xray_version).toBe("25.1.1");
    expect(state.last_seen).not.toBeNull();
  });

  it("returns a null desired hash when there is no config", async () => {
    await makeNode();
    const token = await mint();

    const response = await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1 },
      auth(token),
    );

    expect(response.status).toBe(200);
    expect((await body<EnrollOut>(response)).desired_hash).toBeNull();
  });

  it("records the reported address beside the domain", async () => {
    // The agent's detected_ip is display data; the domain is untouched.
    await makeNode();
    const token = await mint();

    const response = await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1, detected_ip: "203.0.113.7" },
      auth(token),
    );
    expect(response.status).toBe(200);

    const created = await body<NodeOut>(
      await planeJson("GET", `/api/admin/nodes/${node}`),
    );
    expect(created.address).toBe("funky.example.com");
    expect(created.reported_address).toBe("203.0.113.7");
  });

  it("fills the reported address for an addressless node", async () => {
    // A node created without a domain still shows where it is.
    const created = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Node",
    });
    expect(created.status).toBe(201);
    const token = await mint();

    await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1, detected_ip: "203.0.113.7" },
      auth(token),
    );

    const state = await body<NodeOut>(
      await planeJson("GET", `/api/admin/nodes/${node}`),
    );
    expect(state.address).toBe("");
    expect(state.reported_address).toBe("203.0.113.7");
  });

  it("updates only the reported address on re-enroll", async () => {
    // The latest report wins; the admin-set domain never moves.
    await makeNode();
    const token = await mint();
    const headers = auth(token);
    await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1, detected_ip: "203.0.113.7" },
      headers,
    );

    await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 1, detected_ip: "198.51.100.9" },
      headers,
    );

    const state = await body<NodeOut>(
      await planeJson("GET", `/api/admin/nodes/${node}`),
    );
    expect(state.reported_address).toBe("198.51.100.9");
    expect(state.address).toBe("funky.example.com");
  });

  it("answers an unknown protocol with an explicit 400", async () => {
    await makeNode();
    const token = await mint();
    const headers = auth(token);

    const cases: [string, Record<string, unknown>][] = [
      ["/api/node/enroll", { protocol: 999 }],
      ["/api/node/heartbeat", { protocol: 999 }],
      [
        "/api/node/report",
        { protocol: 999, hash: "x", ok: true, stage: "applied" },
      ],
      ["/api/node/stats", { protocol: 999, boot_id: "b", counters: {} }],
    ];
    for (const [path, payload] of cases) {
      const response = await planeJson("POST", path, payload, headers);
      expect(response.status, path).toBe(400);
      const detail = (await body<{ detail: string }>(response)).detail;
      expect(detail).toContain("999");
    }
  });

  it("returns the desired hash and empty actions on heartbeat", async () => {
    await makeNode(node, config());
    const token = await mint();

    const response = await planeJson(
      "POST",
      "/api/node/heartbeat",
      { protocol: 1, applied_hash: null, xray_running: false },
      auth(token),
    );

    expect(response.status).toBe(200);
    const beat = await body<HeartbeatOut>(response);
    expect(beat.desired_hash).toBeTruthy();
    expect(beat.actions).toEqual([]);
  });

  it("flips the desired hash on a user edit with no manual action", async () => {
    // Content-hash convergence: no fan-out, just a new render.
    await makeNode(node, config());
    const token = await mint();
    const headers = auth(token);
    const before = (
      await body<HeartbeatOut>(
        await planeJson("POST", "/api/node/heartbeat", { protocol: 1 }, headers),
      )
    ).desired_hash;

    const created = await planeJson("POST", "/api/admin/users", {
      username: uid("alice"),
      access: {
        [node]: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata"],
        },
      },
    });
    expect(created.status).toBe(201);
    const after = (
      await body<HeartbeatOut>(
        await planeJson("POST", "/api/node/heartbeat", { protocol: 1 }, headers),
      )
    ).desired_hash;

    expect(after).not.toBe(before);
  });

  it("skips the write on a repeated identical heartbeat", async () => {
    // Heartbeats are cheap: no news means no UPDATE.
    await makeNode(node, config());
    const token = await mint();
    const headers = auth(token);
    const payload = { protocol: 1, applied_hash: "abc", xray_running: true };
    await planeJson("POST", "/api/node/heartbeat", payload, headers);
    const before = await sync();

    await planeJson("POST", "/api/node/heartbeat", payload, headers);
    const after = await sync();

    expect(after.last_seen).toBe(before.last_seen);
    expect(after.applied_hash).toBe("abc");
  });

  it("returns the exact render and honors the hash guard", async () => {
    await makeNode(node, config());
    const token = await mint();
    const headers = auth(token);
    const wanted = (
      await body<HeartbeatOut>(
        await planeJson("POST", "/api/node/heartbeat", { protocol: 1 }, headers),
      )
    ).desired_hash as string;

    const full = await planeJson("GET", "/api/node/config", undefined, headers);

    expect(full.status).toBe(200);
    const fetched = await body<{
      hash: string;
      config: Record<string, unknown>;
    }>(full);
    expect(fetched.hash).toBe(wanted);
    expect(fetched.config).toHaveProperty("inbounds");
    expect(full.headers.get("cache-control")).toBe("no-store");
    const current = await planeJson(
      "GET",
      `/api/node/config?hash=${wanted}`,
      undefined,
      headers,
    );
    expect(current.status).toBe(200);
    expect((await body<{ hash: string }>(current)).hash).toBe(wanted);
    const stale = await planeJson(
      "GET",
      "/api/node/config?hash=stale",
      undefined,
      headers,
    );
    expect(stale.status).toBe(409);
    const detail = (
      await body<{ detail: { desired_hash: string } }>(stale)
    ).detail;
    expect(detail.desired_hash).toBe(wanted);
  });

  it("404s config when nothing is renderable", async () => {
    await makeNode();
    const token = await mint();

    const response = await planeJson(
      "GET",
      "/api/node/config",
      undefined,
      auth(token),
    );

    expect(response.status).toBe(404);
  });

  it("adopts the hash and clears the error on a successful report", async () => {
    await makeNode(node, config());
    const token = await mint();
    const headers = auth(token);
    const wanted = (
      await body<HeartbeatOut>(
        await planeJson("POST", "/api/node/heartbeat", { protocol: 1 }, headers),
      )
    ).desired_hash;

    const response = await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 1, hash: wanted, ok: true, stage: "applied" },
      headers,
    );

    expect(response.status).toBe(200);
    const state = await sync();
    expect(state.applied_hash).toBe(wanted);
    expect(state.last_error).toBeNull();
    expect(state.health).toBe("ok");
  });

  it("keeps the hash and records the stage on a failed report", async () => {
    // A failed apply rolled back: drift stays visible, cause stored.
    await makeNode(node, config());
    const token = await mint();
    const headers = auth(token);
    await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 1, hash: "good", ok: true, stage: "applied" },
      headers,
    );

    const response = await planeJson(
      "POST",
      "/api/node/report",
      {
        protocol: 1,
        hash: "bad",
        ok: false,
        stage: "started",
        error: "bind: address in use",
      },
      headers,
    );

    expect(response.status).toBe(200);
    const state = await sync();
    expect(state.applied_hash).toBe("good");
    expect(state.last_error).toBe("bind: address in use");
    expect(state.health).toBe("error:started");
  });

  it("rejects an unknown report stage", async () => {
    await makeNode();
    const token = await mint();

    const response = await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 1, hash: "x", ok: true, stage: "nope" },
      auth(token),
    );

    expect(response.status).toBe(422);
  });

  it("treats a duplicate report as safe", async () => {
    await makeNode(node, config());
    const token = await mint();
    const headers = auth(token);
    const payload = { protocol: 1, hash: "abc", ok: true, stage: "applied" };

    await planeJson("POST", "/api/node/report", payload, headers);
    const before = await sync();
    await planeJson("POST", "/api/node/report", payload, headers);
    const after = await sync();

    expect(after.applied_hash).toBe(before.applied_hash);
  });

  it("accepts stats counters without storing them", async () => {
    await makeNode();
    const token = await mint();

    const response = await planeJson(
      "POST",
      "/api/node/stats",
      {
        protocol: 1,
        boot_id: "b3f1",
        counters: {
          [`user>>>alice@${node}-niigata>>>traffic>>>uplink`]: 10,
          [`user>>>alice@${node}-niigata>>>traffic>>>downlink`]: 20,
        },
      },
      auth(token),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2 });
  });

  it("rejects bad stats counters", async () => {
    await makeNode();
    const token = await mint();
    const headers = auth(token);

    for (const counters of [{ a: -1 }, { a: "many" }, { a: true }]) {
      const response = await planeJson(
        "POST",
        "/api/node/stats",
        { protocol: 1, boot_id: "b", counters },
        headers,
      );
      expect(response.status, JSON.stringify(counters)).toBe(422);
    }
  });

  it("converges a full fake-agent loop", async () => {
    // Fake agent: enroll → poll → fetch → report → in sync.
    await makeNode(node, config());
    const token = await mint();
    const headers = auth(token);
    await planeJson("POST", "/api/admin/users", {
      username: uid("alice"),
      access: {
        [node]: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata"],
        },
      },
    });

    await planeJson("POST", "/api/node/enroll", { protocol: 1 }, headers);
    const wanted = (
      await body<HeartbeatOut>(
        await planeJson(
          "POST",
          "/api/node/heartbeat",
          { protocol: 1, applied_hash: null },
          headers,
        ),
      )
    ).desired_hash;
    const fetched = await body<{ hash: string }>(
      await planeJson(
        "GET",
        `/api/node/config?hash=${wanted}`,
        undefined,
        headers,
      ),
    );
    expect(fetched.hash).toBe(wanted);
    await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 1, hash: wanted, ok: true, stage: "applied" },
      headers,
    );
    const settled = (
      await body<HeartbeatOut>(
        await planeJson(
          "POST",
          "/api/node/heartbeat",
          { protocol: 1, applied_hash: wanted },
          headers,
        ),
      )
    ).desired_hash;

    expect(settled).toBe(wanted);
    expect((await sync()).applied_hash).toBe(wanted);
  });
});
