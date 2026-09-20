/**
 * Tests for the node admin API: CRUD, config, runtime pane, introspection.
 *
 * Ported from tests/workerd/test_admin_nodes.py with its assertions intact.
 * Every id is unique (uid) and list/status assertions are scoped to what
 * this test created, because the whole tier shares one D1.
 */

import { describe, expect, it } from "vitest";

import type { NodeOut } from "../../src/models";
import { planeJson, uid } from "../helpers";

/** WHAT: a minimal authored config a node could hold. */
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

/** WHAT: POST one node and return the response. */
function createNode(
  nodeId: string,
  address = "funky.example.com",
): Promise<Response> {
  return planeJson("POST", "/api/admin/nodes", {
    id: nodeId,
    label: "Tokyo 01",
    address,
  });
}

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the node admin API", () => {
  it("creates, lists, and gets a node", async () => {
    const node = uid("n");
    const response = await createNode(node);

    expect(response.status).toBe(201);
    expect((await body<NodeOut>(response)).has_config).toBe(false);
    const listing = await planeJson("GET", "/api/admin/nodes");
    const mine = (await body<NodeOut[]>(listing)).filter(
      (entry) => entry.id === node,
    );
    expect(mine).toHaveLength(1);
    const got = await planeJson("GET", `/api/admin/nodes/${node}`);
    expect((await body<NodeOut>(got)).label).toBe("Tokyo 01");
    const missing = await planeJson("GET", "/api/admin/nodes/ghost");
    expect(missing.status).toBe(404);
  });

  it("rejects duplicate and bad ids", async () => {
    const node = uid("n");
    await createNode(node);

    expect((await createNode(node)).status).toBe(409);
    for (const badId of ["Tokyo01", "tokyo-01", "a".repeat(33)]) {
      const response = await planeJson("POST", "/api/admin/nodes", {
        id: badId,
        label: "x",
      });
      expect(response.status, badId).toBe(422);
    }
  });

  it("merges partial fields on update", async () => {
    const node = uid("n");
    await createNode(node);

    const response = await planeJson("PUT", `/api/admin/nodes/${node}`, {
      label: "Tokyo 01 (new)",
    });
    const updated = await body<NodeOut>(response);

    expect(response.status).toBe(200);
    expect(updated.label).toBe("Tokyo 01 (new)");
    expect(updated.address).toBe("funky.example.com");
  });

  it("round-trips the config and renders the runtime pane", async () => {
    const node = uid("n");
    await createNode(node);
    const put = await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());
    expect(put.status).toBe(200);

    const got = await planeJson("GET", `/api/admin/nodes/${node}/config`);
    expect(await got.json()).toEqual(config());
    const runtime = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/config/runtime`,
    );
    const pane = await body<{ config: Record<string, unknown>; hash: string; warnings: string[] }>(
      runtime,
    );
    expect(runtime.status).toBe(200);
    expect(pane.config).toHaveProperty("inbounds");
    expect(pane.hash).toBeTruthy();
    expect(Array.isArray(pane.warnings)).toBe(true);
    const nodeOut = await planeJson("GET", `/api/admin/nodes/${node}`);
    expect((await body<NodeOut>(nodeOut)).has_config).toBe(true);
  });

  it("rejects prequalified tags without saving", async () => {
    const node = uid("n");
    await createNode(node);
    const payload = config();
    payload["inbounds"] = [
      { ...(config()["inbounds"] as Record<string, unknown>[])[0], tag: `reality-${node}` },
    ];

    const response = await planeJson(
      "PUT",
      `/api/admin/nodes/${node}/config`,
      payload,
    );
    const detail = (await body<{ detail: string[] }>(response)).detail;

    expect(response.status).toBe(422);
    expect(detail[0]).toContain(`reality-${node}`);
    const got = await planeJson("GET", `/api/admin/nodes/${node}/config`);
    expect(got.status).toBe(404);
  });

  it("404s config endpoints without a config", async () => {
    const node = uid("n");
    await createNode(node);

    for (const path of [
      `/api/admin/nodes/${node}/config`,
      `/api/admin/nodes/${node}/config/runtime`,
    ]) {
      const response = await planeJson("GET", path);
      expect(response.status, path).toBe(404);
    }
  });

  it("503s tag introspection without a config and 404s for a ghost", async () => {
    const node = uid("n");
    await createNode(node);

    const inbounds = await planeJson("GET", `/api/admin/nodes/${node}/inbounds`);
    expect(inbounds.status).toBe(503);
    const ghost = await planeJson("GET", "/api/admin/nodes/ghost/inbounds");
    expect(ghost.status).toBe(404);
  });

  it("summarizes inbounds and outbounds", async () => {
    const node = uid("n");
    await createNode(node);
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());

    const inbounds = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/inbounds`,
    );
    expect(await inbounds.json()).toEqual([
      { tag: "reality", protocol: "vless", network: "", security: "" },
    ]);
    const outbounds = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/outbounds`,
    );
    expect(await outbounds.json()).toEqual([
      { tag: "niigata", protocol: "freedom" },
    ]);
  });

  it("counts the nodes and users this test created", async () => {
    const other = uid("n");
    const node = uid("n");
    await createNode(node);
    await createNode(other);
    await planeJson("POST", "/api/admin/users", {
      username: uid("alice"),
      access: { [node]: { allowed_inbounds: [], allowed_outbounds: [] } },
    });

    const status = await planeJson("GET", "/api/admin/status");
    const counts = await body<{ node_count: number; user_count: number }>(status);

    expect(counts.node_count).toBeGreaterThanOrEqual(2);
    expect(counts.user_count).toBeGreaterThanOrEqual(1);
  });
});
