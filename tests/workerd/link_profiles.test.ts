/**
 * Tests for the link-profile admin API, over a real plane.
 *
 * Ported from tests/workerd/test_link_profiles.py with its assertions
 * intact. Profiles are validated HTTP resources with their own identity and
 * status codes; profile writes are client-side only and never touch any
 * render path.
 */

import { describe, expect, it } from "vitest";

import { planeJson, uid } from "../helpers";

/** WHAT: an authored config with the inbound a CDN-style profile attaches to. */
function config(): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "xhttp",
        protocol: "vless",
        port: 8080,
        settings: { clients: [] },
        streamSettings: { network: "xhttp" },
      },
    ],
    outbounds: [{ tag: "niigata", protocol: "freedom" }],
  };
}

/** WHAT: a valid CDN-style profile payload. */
function profile(
  profileId = "cdn",
  inbound = "xhttp",
): Record<string, unknown> {
  return {
    id: profileId,
    inbound_tag: inbound,
    label: "CDN",
    overrides: {
      address: "cdn.example.com",
      port: 443,
      security: "tls",
      sni: "cdn.example.com",
    },
  };
}

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the link-profile admin API", () => {
  /** WHAT: create the test's node with a profile-ready config. */
  async function makeNode(): Promise<string> {
    const node = uid("n");
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Tokyo 01",
      address: "funky.example.com",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const put = await planeJson(
      "PUT",
      `/api/admin/nodes/${node}/config`,
      config(),
    );
    expect(put.status, await put.clone().text()).toBe(200);
    return node;
  }

  it("round-trips create, get, update, and delete", async () => {
    const node = await makeNode();
    const created = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      profile(),
    );

    expect(created.status).toBe(201);
    const createdBody = await body<{ id: string; inbound_tag: string }>(created);
    expect(createdBody.id).toBe("cdn");
    expect(createdBody.inbound_tag).toBe("xhttp");
    const listed = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/link-profiles`,
    );
    expect((await body<{ id: string }[]>(listed)).map((row) => row.id)).toEqual([
      "cdn",
    ]);
    const fetched = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/link-profiles/cdn`,
    );
    expect((await body<{ label: string }>(fetched)).label).toBe("CDN");

    const updated = await planeJson(
      "PUT",
      `/api/admin/nodes/${node}/link-profiles/cdn`,
      { label: "CDN Edge", overrides: { address: "edge.example.com" } },
    );
    expect(updated.status).toBe(200);
    expect((await body<{ label: string }>(updated)).label).toBe("CDN Edge");

    const deleted = await planeJson(
      "DELETE",
      `/api/admin/nodes/${node}/link-profiles/cdn`,
    );
    expect(deleted.status).toBe(204);
    const missing = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/link-profiles/cdn`,
    );
    expect(missing.status).toBe(404);
  });

  it("keeps profile writes client-side only", async () => {
    const node = await makeNode();
    await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      profile(),
    );
    await planeJson(
      "PUT",
      `/api/admin/nodes/${node}/link-profiles/cdn`,
      { label: "CDN Edge" },
    );
    await planeJson(
      "DELETE",
      `/api/admin/nodes/${node}/link-profiles/cdn`,
    );

    const response = await planeJson("GET", `/api/admin/nodes/${node}/sync`);
    const sync = await body<{ applied_hash: string | null; last_seen: number | null }>(
      response,
    );
    expect(sync.applied_hash).toBeNull();
    expect(sync.last_seen).toBeNull();
  });

  it("rejects duplicates, unknown inbounds, and missing profiles", async () => {
    const node = await makeNode();
    await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      profile(),
    );

    const duplicate = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      profile(),
    );
    const unknownInbound = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      profile("other", "ghost"),
    );
    const ghostNode = await planeJson(
      "POST",
      "/api/admin/nodes/ghost/link-profiles",
      profile(),
    );
    const missing = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/link-profiles/ghost`,
    );

    expect(duplicate.status).toBe(409);
    expect(unknownInbound.status).toBe(422);
    expect(ghostNode.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("422s invalid slugs, labels, and overrides", async () => {
    const node = await makeNode();
    const badId = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      profile("Bad ID"),
    );
    const badLabel = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      { ...profile("bad-label"), label: "  " },
    );
    const badOverride = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      { ...profile("bad-override"), overrides: { pbk: "x" } },
    );
    const badValue = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/link-profiles`,
      { ...profile("bad-value"), overrides: { port: true } },
    );

    expect(badId.status).toBe(422);
    expect(badLabel.status).toBe(422);
    expect(badOverride.status).toBe(422);
    expect(badValue.status).toBe(422);
  });
});
