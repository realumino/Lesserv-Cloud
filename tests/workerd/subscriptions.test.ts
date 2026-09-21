/**
 * Subscriptions: the capability URL and its body.
 *
 * The M6 done-when made testable (docs/M6-PLAN.md): a rotatable sub_token;
 * /sub/{token} returning base64 of the newline-joined link list across
 * every node with each link carrying its own node's address; disabled or
 * expired users getting an empty body rather than an error; and adding
 * node #2 enriching the same URL's body without the URL changing.
 *
 * WHY the decoded body is compared to the admin links endpoint: the two are
 * specified as presentations of one aggregation, and byte parity here is
 * what keeps that claim honest.
 */

import { describe, expect, it } from "vitest";

import type { UserOut } from "../../src/models";
import { planeFetch, planeJson, uid } from "../helpers";

/** WHAT: an authored config with one REALITY inbound and one named exit. */
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

/** WHAT: one admin-visible link as the links endpoint returns it. */
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

/** WHAT: decode the subscription body exactly as a client would. */
function decode(text: string): string[] {
  if (text === "") {
    return [];
  }
  return atob(text).split("\n");
}

describe("the subscription endpoint", () => {
  /** WHAT: create a node, paste its config, and return its id. */
  async function makeNode(
    nodeId: string,
    address: string,
    exitTag: string,
  ): Promise<string> {
    const created = await planeJson("POST", "/api/admin/nodes", {
      id: nodeId,
      label: `Node ${nodeId}`,
      address,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const put = await planeJson("PUT", `/api/admin/nodes/${nodeId}/config`, config(exitTag));
    expect(put.status, await put.clone().text()).toBe(200);
    return nodeId;
  }

  /** WHAT: create a user with the given per-node access map. */
  async function makeUser(
    username: string,
    access: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<UserOut> {
    const response = await planeJson("POST", "/api/admin/users", {
      username,
      access,
      ...extra,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return body<UserOut>(response);
  }

  /** WHAT: grant one user access to one node with this repo's stock tags. */
  function accessFor(nodeId: string): Record<string, unknown> {
    return {
      [nodeId]: {
        allowed_inbounds: ["reality"],
        allowed_outbounds: ["alpha"],
      },
    };
  }

  /** WHAT: the admin link list, for parity checks against the body. */
  async function adminLinks(username: string): Promise<LinkOut[]> {
    const response = await planeJson("GET", `/api/admin/users/${username}/links`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await body<{ links: LinkOut[] }>(response)).links;
  }

  /** WHAT: fetch the subscription URL as its client would. */
  async function subGet(token: string): Promise<Response> {
    return planeFetch(`/sub/${token}`);
  }

  it("auto-mints a token at creation and rotates it", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", "alpha");
    const created = await makeUser(user, accessFor(node));

    expect(created.sub_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.sub_token_created_at).toBeGreaterThan(0);

    const got = await planeJson("GET", `/api/admin/users/${user}`);
    expect((await body<UserOut>(got)).sub_token).toBe(created.sub_token);

    const oldToken = created.sub_token!;
    const rotated = await planeJson("POST", `/api/admin/users/${user}/sub-token`);
    expect(rotated.status).toBe(201);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    const minted = await body<{ sub_token: string; username: string }>(rotated);
    expect(minted.username).toBe(user);
    expect(minted.sub_token).not.toBe(oldToken);

    // The old URL dies immediately; the new one serves links.
    const old = await subGet(oldToken);
    expect(old.status).toBe(200);
    expect(await old.text()).toBe("");
    const fresh = await subGet(minted.sub_token);
    expect((await fresh.text()).length).toBeGreaterThan(0);

    const missing = await planeJson("POST", "/api/admin/users/ghost/sub-token");
    expect(missing.status).toBe(404);
  });

  it("serves exactly the admin link list, base64-encoded", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", "alpha");
    const created = await makeUser(user, accessFor(node));

    const response = await subGet(created.sub_token!);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();

    const links = await adminLinks(user);
    expect(links.length).toBeGreaterThan(0);
    expect(decode(text)).toEqual(links.map((link) => link.uri));
  });

  it("carries each node's own address in its links", async () => {
    const nodeA = uid("a");
    const nodeB = uid("b");
    const user = uid("alice");
    await makeNode(nodeA, "a.example.com", "alpha");
    await makeNode(nodeB, "b.example.com", "beta");
    const created = await makeUser(user, {
      [nodeA]: {
        allowed_inbounds: ["reality"],
        allowed_outbounds: ["alpha"],
      },
      [nodeB]: {
        allowed_inbounds: ["reality"],
        allowed_outbounds: ["beta"],
      },
    });

    const response = await subGet(created.sub_token!);
    const uris = decode(await response.text());
    const links = await adminLinks(user);

    expect(uris).toEqual(links.map((link) => link.uri));
    expect(uris.length).toBe(2);
    const aUri = uris.find((uri) => uri.includes(nodeA));
    const bUri = uris.find((uri) => uri.includes(nodeB));
    expect(aUri).toContain("a.example.com");
    expect(aUri).not.toContain("b.example.com");
    expect(bUri).toContain("b.example.com");
    expect(bUri).not.toContain("a.example.com");
  });

  it("enriches the same URL when node #2 is added", async () => {
    const nodeA = uid("a");
    const nodeB = uid("b");
    const user = uid("alice");
    await makeNode(nodeA, "a.example.com", "alpha");
    await makeNode(nodeB, "b.example.com", "beta");
    const created = await makeUser(user, accessFor(nodeA));
    const token = created.sub_token!;

    const before = decode(await (await subGet(token)).text());
    expect(before.length).toBe(1);

    // B's exit tag is beta, not alpha — grant B with its own tags.
    const updated = await planeJson("PUT", `/api/admin/users/${user}`, {
      access: {
        [nodeA]: { allowed_inbounds: ["reality"], allowed_outbounds: ["alpha"] },
        [nodeB]: { allowed_inbounds: ["reality"], allowed_outbounds: ["beta"] },
      },
    });
    expect(updated.status, await updated.clone().text()).toBe(200);

    const afterResponse = await subGet(token);
    const after = decode(await afterResponse.text());

    expect(token).toBe(created.sub_token); // the URL itself never changed
    expect(after.length).toBe(2);
    for (const uri of before) {
      expect(after).toContain(uri);
    }
    expect(after.some((uri) => uri.includes("b.example.com"))).toBe(true);
  });

  it("answers disabled and expired users with an empty body", async () => {
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", "alpha");
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const created = await makeUser(user, accessFor(node), {
      status: "disabled",
    });
    const token = created.sub_token!;

    // Disabled: empty.
    expect(await (await subGet(token)).text()).toBe("");

    // Disabled with a future expiry is still empty.
    await planeJson("PUT", `/api/admin/users/${user}`, { expire: future });
    expect(await (await subGet(token)).text()).toBe("");

    // Re-enabled with a future expiry: links return on the same URL.
    await planeJson("PUT", `/api/admin/users/${user}`, { status: "active" });
    expect((await (await subGet(token)).text()).length).toBeGreaterThan(0);

    // expire: 0 means never, not "expired at the epoch".
    await planeJson("PUT", `/api/admin/users/${user}`, { expire: 0 });
    expect((await (await subGet(token)).text()).length).toBeGreaterThan(0);

    // Past expiry: empty again, same URL, no error anywhere.
    await planeJson("PUT", `/api/admin/users/${user}`, { expire: past });
    const expired = await subGet(token);
    expect(expired.status).toBe(200);
    expect(await expired.text()).toBe("");
  });

  it("treats unknown and rotated-out tokens like any empty body", async () => {
    const never = crypto.randomUUID().replaceAll("-", "").slice(0, 43);
    const unknown = await subGet(never);
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get("content-type")).toContain("text/plain");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.text()).toBe("");

    // A rotated-away token behaves identically to a never-minted one.
    const node = uid("n");
    const user = uid("alice");
    await makeNode(node, "funky.example.com", "alpha");
    const created = await makeUser(user, accessFor(node));
    const rotated = await planeJson("POST", `/api/admin/users/${user}/sub-token`);
    const minted = await body<{ sub_token: string }>(rotated);
    const stale = await subGet(created.sub_token!);
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("");
    expect((await (await subGet(minted.sub_token)).text()).length).toBeGreaterThan(0);

    // Route shape stays fail-closed: no bare-group root, no extra segments,
    // no non-GET verbs.
    expect((await planeFetch("/sub/")).status).toBe(404);
    expect((await planeFetch(`/sub/${never}/extra`)).status).toBe(404);
    expect(
      (await planeJson("POST", `/sub/${never}`, {})).status,
    ).toBe(404);
  });

  it("skips unusable nodes silently and empties a user with none", async () => {
    const configless = uid("c");
    const noAddress = uid("d");
    const good = uid("g");
    const user = uid("alice");
    // A node with no config at all.
    await planeJson("POST", "/api/admin/nodes", {
      id: configless,
      label: "No config",
      address: "x.example.com",
    });
    // A node with a config but no address and no usable listen.
    await makeNode(noAddress, "", "alpha");
    await makeNode(good, "g.example.com", "alpha");
    const created = await makeUser(user, {
      [configless]: { allowed_inbounds: [], allowed_outbounds: [] },
      [noAddress]: { allowed_inbounds: ["reality"], allowed_outbounds: ["alpha"] },
      [good]: { allowed_inbounds: ["reality"], allowed_outbounds: ["alpha"] },
    });

    const uris = decode(await (await subGet(created.sub_token!)).text());
    expect(uris.length).toBe(1);
    expect(uris[0]).toContain("g.example.com");

    // The same state errors on the admin surface (409) but never here.
    const adminless = uid("e");
    const emptyUser = uid("bob");
    await makeNode(adminless, "y.example.com", "alpha");
    await planeJson("POST", "/api/admin/nodes", {
      id: "skipnode" + uid(""),
      label: "skip",
    });
    const made = await makeUser(emptyUser, {
      [adminless]: { allowed_inbounds: ["reality"], allowed_outbounds: ["alpha"] },
    });
    // Unaddressable-config case: strip the node's address after linking.
    await planeJson("PUT", `/api/admin/nodes/${adminless}`, { address: "" });
    const adminView = await planeJson(
      "GET",
      `/api/admin/users/${emptyUser}/links`,
    );
    expect(adminView.status).toBe(409);
    const empty = await subGet(made.sub_token!);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe("");
  });

  it("never leaks one user's links into another's body", async () => {
    const node = uid("n");
    const alice = uid("alice");
    const bob = uid("bob");
    await makeNode(node, "funky.example.com", "alpha");
    const a = await makeUser(alice, accessFor(node));
    const b = await makeUser(bob, accessFor(node));

    const aUris = decode(await (await subGet(a.sub_token!)).text());
    const bUris = decode(await (await subGet(b.sub_token!)).text());

    expect(aUris.length).toBe(1);
    expect(bUris.length).toBe(1);

    // The UUID is the per-user secret the URI carries; the email only shows
    // in server-side counters. Each body must contain its own user's UUID
    // and never the other's.
    const uuidOf = async (username: string): Promise<string> => {
      const got = await planeJson("GET", `/api/admin/users/${username}`);
      const access = (await body<UserOut>(got)).access[node]!;
      return access.uuids["alpha"]!;
    };
    const aUuid = await uuidOf(alice);
    const bUuid = await uuidOf(bob);
    expect(aUuid).not.toBe(bUuid);
    expect(aUris[0]).toContain(aUuid);
    expect(aUris[0]).not.toContain(bUuid);
    expect(bUris[0]).toContain(bUuid);
    expect(bUris[0]).not.toContain(aUuid);
  });
});
