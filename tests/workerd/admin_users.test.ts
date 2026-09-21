/**
 * Tests for the user admin API: CRUD with per-node access, and share links.
 *
 * Ported from tests/workerd/test_admin_users.py with its assertions intact.
 * The payload/response shapes and status-code semantics (404/409/503/409)
 * are the contract the SPA is built on; the user-service uuid invariants
 * ride along as HTTP tests (uuid stability is visible in the GET response).
 */

import { describe, expect, it } from "vitest";

import type { UserOut } from "../../src/models";
import { planeJson, uid } from "../helpers";

/** WHAT: an authored config with one REALITY inbound and one exit. */
function config(listen = "0.0.0.0"): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "reality",
        protocol: "vless",
        listen,
        port: 443,
        settings: { clients: [], flow: "xtls-rprx-vision" },
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
    outbounds: [{ tag: "niigata", protocol: "freedom" }],
  };
}

/** WHAT: one generated link as the endpoint returns it. */
type LinkOut = {
  node: string;
  inbound: string;
  outbound: string;
  email: string;
  profile: string | null;
  label: string | null;
  uri: string;
};

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the user admin API", () => {
  /** WHAT: create a node via the API; optionally paste its config. */
  async function makeNode(
    nodeId: string,
    address = "funky.example.com",
    nodeConfig: Record<string, unknown> | null = null,
  ): Promise<void> {
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: nodeId,
      label: "Node",
      address,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    if (nodeConfig !== null) {
      const put = await planeJson(
        "PUT",
        `/api/admin/nodes/${nodeId}/config`,
        nodeConfig,
      );
      expect(put.status, await put.clone().text()).toBe(200);
    }
  }

  /** WHAT: create a user with access to one node via the API. */
  function makeUser(
    username: string,
    nodeId: string,
    status?: string,
  ): Promise<Response> {
    const payload: Record<string, unknown> = {
      username,
      access: {
        [nodeId]: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata"],
        },
      },
    };
    if (status) {
      payload["status"] = status;
    }
    return planeJson("POST", "/api/admin/users", payload);
  }

  it("creates with nested access and minted uuids", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node);
    const response = await makeUser(user, node);

    expect(response.status).toBe(201);
    const access = (await body<UserOut>(response)).access[node]!;
    expect(access.allowed_outbounds).toEqual(["niigata"]);
    expect(Object.keys(access.uuids)).toEqual(["niigata"]);
    expect(access.uuids["niigata"]).not.toBe("");
  });

  it("rejects duplicate users, unknown nodes, and bad usernames", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node);
    const first = await makeUser(user, node);
    expect(first.status).toBe(201);
    expect((await makeUser(user, node)).status).toBe(409);
    const ghost = await planeJson("POST", "/api/admin/users", {
      username: uid("bob"),
      access: { nowhere: { allowed_inbounds: [], allowed_outbounds: [] } },
    });
    expect(ghost.status).toBe(404);
    const bad = await planeJson("POST", "/api/admin/users", {
      username: "a li",
      access: {},
    });
    expect(bad.status).toBe(422);
  });

  it("updates and deletes via the API", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node);
    await makeUser(user, node);

    const updated = await planeJson("PUT", `/api/admin/users/${user}`, {
      note: "x",
    });
    expect((await body<UserOut>(updated)).note).toBe("x");

    const deleted = await planeJson("DELETE", `/api/admin/users/${user}`);
    expect(deleted.status).toBe(204);
    const got = await planeJson("GET", `/api/admin/users/${user}`);
    expect(got.status).toBe(404);
    const again = await planeJson("DELETE", `/api/admin/users/${user}`);
    expect(again.status).toBe(404);
  });

  it("treats an updated access map as authoritative membership", async () => {
    const node = uid("n");
    const other = uid("n");
    const user = uid("alice");
    await makeNode(node);
    await makeNode(other);
    await makeUser(user, node);
    await planeJson("PUT", `/api/admin/users/${user}`, {
      access: { [other]: { allowed_inbounds: [], allowed_outbounds: [] } },
    });

    const got = await planeJson("GET", `/api/admin/users/${user}`);
    const updated = await body<UserOut>(got);

    expect(Object.keys(updated.access)).toEqual([other]);
  });

  it("adds exactly one new uuid when access grows", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node);
    const created = await makeUser(user, node);
    const firstUuids = (await body<UserOut>(created)).access[node]!.uuids;

    await planeJson("PUT", `/api/admin/users/${user}`, {
      access: {
        [node]: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata", "other"],
        },
      },
    });

    const got = await planeJson("GET", `/api/admin/users/${user}`);
    const uuids = (await body<UserOut>(got)).access[node]!.uuids;

    expect(uuids["niigata"]).toBe(firstUuids["niigata"]);
    expect(uuids).toHaveProperty("other");
  });

  it("leaves access rows alone when access is omitted", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node);
    await makeUser(user, node);

    await planeJson("PUT", `/api/admin/users/${user}`, { note: "x" });

    const got = await planeJson("GET", `/api/admin/users/${user}`);
    expect((await body<UserOut>(got)).access).toHaveProperty(node);
  });

  it("creates a user with no access as empty access", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node);
    const response = await planeJson("POST", "/api/admin/users", {
      username: user,
    });

    expect(response.status).toBe(201);
    expect((await body<UserOut>(response)).access).toEqual({});
  });

  it("builds a reality URI from node address and stored key", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", config());
    await makeUser(user, node);
    const runtime = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/config/runtime`,
    );
    expect(runtime.status, await runtime.clone().text()).toBe(200);

    const response = await planeJson("GET", `/api/admin/users/${user}/links`);

    expect(response.status).toBe(200);
    const links = (await body<{ links: LinkOut[] }>(response)).links;
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.node).toBe(node);
    expect(link.inbound).toBe(`reality-${node}`);
    expect(link.outbound).toBe(`${node}-niigata`);
    expect(link.email).toBe(`${user}@${node}-niigata`);
    expect(link.profile).toBeNull();
    expect(link.label).toBe("Node · REALITY → Niigata");
    expect(link.uri).toContain("vless://");
    expect(link.uri).toContain("funky.example.com:443");
    expect(link.uri).toContain("security=reality");
    expect(link.uri).toContain("sid=1234");
    const reality = await planeJson("GET", `/api/admin/nodes/${node}/reality`);
    const keys = (await body<{ keys: { public_key: string }[] }>(reality)).keys;
    expect(link.uri).toContain(`pbk=${keys[0]!.public_key}`);
  });

  it("includes one profile variant per exit", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", config());
    await makeUser(user, node);
    const created = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      {
        id: "cdn",
        inbound_tag: "reality",
        label: "CDN",
        overrides: { address: "cdn.example.com", port: 443 },
      },
    );
    expect(created.status, await created.clone().text()).toBe(201);

    const response = await planeJson("GET", `/api/admin/users/${user}/links`);

    expect(response.status).toBe(200);
    const links = (await body<{ links: LinkOut[] }>(response)).links;
    expect(links).toHaveLength(2);
    expect(links.map((link) => [link.profile, link.label])).toEqual([
      [null, "Node · REALITY → Niigata"],
      ["cdn", "Node · CDN → Niigata"],
    ]);
    expect(links[1]!.uri).toContain("cdn.example.com:443");
  });

  it("404s links for an unknown user", async () => {
    const response = await planeJson("GET", "/api/admin/users/ghost/links");
    expect(response.status).toBe(404);
  });

  it("503s when access exists but no node config does", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", null);
    await makeUser(user, node);

    const response = await planeJson("GET", `/api/admin/users/${user}/links`);
    expect(response.status).toBe(503);
  });

  it("409s when no node has a usable address", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "", config());
    await makeUser(user, node);

    const response = await planeJson("GET", `/api/admin/users/${user}/links`);
    expect(response.status).toBe(409);
  });

  it("200s with an empty list for a user without access", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", config());
    await planeJson("POST", "/api/admin/users", { username: user });

    const response = await planeJson("GET", `/api/admin/users/${user}/links`);

    expect(response.status).toBe(200);
    expect((await body<{ links: LinkOut[] }>(response)).links).toEqual([]);
  });

  it("warns for disabled users and skipped nodes", async () => {
    const node = uid("n");
    const other = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", config());
    await makeNode(other, "funky.example.com", null);
    const created = await planeJson("POST", "/api/admin/users", {
      username: user,
      status: "disabled",
      access: {
        [node]: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata"],
        },
        [other]: { allowed_inbounds: [], allowed_outbounds: [] },
      },
    });
    expect(created.status).toBe(201);

    const response = await planeJson("GET", `/api/admin/users/${user}/links`);
    const payload = await body<{ links: LinkOut[]; warnings: string[] }>(response);

    expect(payload.links.length).toBeGreaterThan(0);
    expect(payload.warnings.some((warning) => warning.includes(other))).toBe(true);
    expect(payload.warnings.some((warning) => warning.includes("disabled"))).toBe(true);
  });
});
