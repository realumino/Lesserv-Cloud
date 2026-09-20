/**
 * The status and `{detail}` envelope contract the admin SPA is built on.
 *
 * WHY this file exists: `frontend/src/api.ts` parses `{detail}` for every
 * non-2xx, branches on exact statuses, and treats secret-bearing responses
 * as uncacheable. Those are wire facts no service test sees, so they are
 * pinned end-to-end here: malformed JSON is a 422 with a `{msg}` list,
 * semantic errors keep a string or string-list `detail`, unknown routes
 * inside a group are a 404 with the same envelope as the guard's, deletes
 * are 204 with an empty body, and tokens/configs are `no-store`.
 */

import { describe, expect, it } from "vitest";

import { planeFetch, planeJson, uid } from "../helpers";

/** WHAT: the `detail` field of one error response. */
async function detail(response: Response): Promise<unknown> {
  return ((await response.json()) as { detail: unknown }).detail;
}

describe("the error envelope", () => {
  it("422s malformed JSON with a FastAPI-shaped detail list", async () => {
    const response = await planeFetch("/api/admin/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await detail(response)).toEqual([{ msg: "JSON decode error" }]);
  });

  it("422s validation failures as a detail list of messages", async () => {
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: "BAD ID",
      label: "x",
    });

    expect(response.status).toBe(422);
    expect(await detail(response)).toEqual([
      { msg: "node id must be 1-32 lowercase letters or digits" },
    ]);
  });

  it("keeps semantic 422s as a list of strings", async () => {
    const node = uid("n");
    await planeJson("POST", "/api/admin/nodes", { id: node, label: "n" });

    const response = await planeJson(
      "PUT",
      `/api/admin/nodes/${node}/config`,
      {
        inbounds: [{ tag: `reality-${node}`, protocol: "vless" }],
        outbounds: [],
      },
    );

    expect(response.status).toBe(422);
    const list = (await detail(response)) as string[];
    expect(Array.isArray(list)).toBe(true);
    expect(list[0]).toContain(`reality-${node}`);
  });

  it("409s a duplicate node id with a string detail", async () => {
    const node = uid("n");
    await planeJson("POST", "/api/admin/nodes", { id: node, label: "n" });

    const response = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "n",
    });

    expect(response.status).toBe(409);
    expect(await detail(response)).toBe("node id already exists");
  });

  it("404s an unknown route inside an allowed group", async () => {
    for (const path of ["/api/admin/ghost", "/api/node/ghost"]) {
      const response = await planeFetch(path);

      expect(response.status, path).toBe(404);
      expect(await detail(response)).toBe("Not found");
    }
  });

  it("404s outside the route groups with the guard's envelope", async () => {
    for (const path of ["/api/admin", "/api/users", "/docs", "/openapi.json"]) {
      const response = await planeFetch(path);

      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await detail(response)).toBe("Not found");
    }
  });

  it("204s a delete with an empty body", async () => {
    const username = uid("alice");
    await planeJson("POST", "/api/admin/users", { username });

    const response = await planeJson("DELETE", `/api/admin/users/${username}`);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("marks secret-bearing responses no-store", async () => {
    const node = uid("n");
    await planeJson("POST", "/api/admin/nodes", { id: node, label: "n" });
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, {
      inbounds: [
        { tag: "reality", protocol: "vless", settings: { clients: [] } },
      ],
      outbounds: [],
    });
    const minted = await planeJson("POST", `/api/admin/nodes/${node}/token`);
    const token = ((await minted.json()) as { token: string }).token;

    const config = await planeJson("GET", "/api/node/config", undefined, {
      Authorization: `Bearer ${token}`,
      "X-Lesserv-Node": node,
    });

    expect(minted.headers.get("cache-control")).toBe("no-store");
    expect(config.status).toBe(200);
    expect(config.headers.get("cache-control")).toBe("no-store");
  });
});
