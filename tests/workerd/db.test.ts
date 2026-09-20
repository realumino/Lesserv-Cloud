/**
 * Round-trips through the node/user/access/key/profile SQL, on real D1.
 *
 * WHY this tier: the data layer only exists under workerd, so it runs
 * against the production schema (applied in tests/setup.ts) and every
 * assertion goes through `src/db.ts` exactly as the services will. Ported
 * from the pre-workerd `tests/test_db.py` round-trips, extended with the
 * columns and setters the M3+ services added.
 *
 * WHY unique ids (`uid`): the vitest plugin shares one D1 across the tests
 * in this file — there is no per-test storage isolation — so fixed ids
 * would collide, exactly like the Python workerd harness.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import * as db from "../../src/db";
import { uid } from "../helpers";

const conn = env.DB;

/** WHAT: insert one boring node so a test can exercise a setter. */
async function makeNode(
  id: string,
  label = "Tokyo 01",
  address = "funky.example.com",
): Promise<void> {
  await db.createNode(conn, { id, label, address, created_at: 1 });
}

/** WHAT: insert one active user with no notes. */
async function makeUser(username: string): Promise<void> {
  await db.createUser(conn, {
    username,
    status: "active",
    expire: null,
    note: null,
    created_at: 1,
  });
}

/** WHAT: insert one CDN-style profile for a node. */
async function makeProfile(nodeId: string): Promise<void> {
  await db.createLinkProfile(conn, {
    node_id: nodeId,
    id: "cdn",
    inbound_tag: "xhttp",
    label: "CDN",
    overrides: { address: "cdn.example.com", port: 443 },
    created_at: 1,
  });
}

describe("the D1 data layer", () => {
  it("round-trips a node row", async () => {
    const nodeId = uid("n");
    await makeNode(nodeId);

    const node = await db.getNode(conn, nodeId);

    expect(node?.label).toBe("Tokyo 01");
    expect(node?.address).toBe("funky.example.com");
    expect(node?.config_json).toBeNull();
    expect((await db.listNodes(conn)).map((row) => row.id)).toContain(nodeId);
  });

  it("returns null for a missing node", async () => {
    expect(await db.getNode(conn, uid("ghost"))).toBeNull();
  });

  it("stores and clears the opaque config blob", async () => {
    const nodeId = uid("n");
    await makeNode(nodeId);
    const config = { inbounds: [{ tag: "reality" }] };

    await db.setNodeConfig(conn, nodeId, config);
    expect((await db.getNode(conn, nodeId))?.config_json).toEqual(config);

    await db.setNodeConfig(conn, nodeId, null);
    expect((await db.getNode(conn, nodeId))?.config_json).toBeNull();
  });

  it("updates node label/address and the reported address separately", async () => {
    const nodeId = uid("n");
    await makeNode(nodeId);

    await db.replaceNode(conn, {
      id: nodeId,
      label: "Tokyo 01 (new)",
      address: "new.example.com",
    });
    await db.setReportedAddress(conn, nodeId, "203.0.113.7");

    const node = await db.getNode(conn, nodeId);
    expect(node?.label).toBe("Tokyo 01 (new)");
    expect(node?.address).toBe("new.example.com");
    expect(node?.reported_address).toBe("203.0.113.7");
    expect(node?.config_json).toBeNull();
  });

  it("writes liveness columns in one statement and replaces the token hash", async () => {
    const nodeId = uid("n");
    await makeNode(nodeId);

    await db.touchNode(conn, nodeId, 1700, "ok", "0.1.0", "25.1.1", null, "abc");
    await db.setTokenHash(conn, nodeId, "first");
    await db.setTokenHash(conn, nodeId, "second");

    const node = await db.getNode(conn, nodeId);
    expect(node).toMatchObject({
      last_seen: 1700,
      health: "ok",
      agent_version: "0.1.0",
      xray_version: "25.1.1",
      last_error: null,
      applied_hash: "abc",
      token_hash: "second",
    });
  });

  it("lists users username-ordered and fetches one by name", async () => {
    const alice = uid("alice");
    const bob = uid("bob");
    await makeUser(bob);
    await makeUser(alice);

    const ours = (await db.listUsers(conn))
      .map((row) => row.username)
      .filter((username) => username === alice || username === bob);
    expect(ours).toEqual([alice, bob]);
    expect((await db.getUser(conn, alice))?.status).toBe("active");
    expect(await db.getUser(conn, uid("ghost"))).toBeNull();
  });

  it("replaces a user's editable columns", async () => {
    const username = uid("alice");
    await makeUser(username);

    await db.replaceUser(conn, {
      username,
      status: "disabled",
      expire: 99,
      note: "x",
    });

    const user = await db.getUser(conn, username);
    expect(user).toMatchObject({ status: "disabled", expire: 99, note: "x" });
  });

  it("round-trips access JSON columns and replaces the whole row", async () => {
    const username = uid("alice");
    const nodeId = uid("n");
    await db.upsertAccess(conn, username, nodeId, ["reality"], ["niigata"], {
      niigata: "u1",
    });

    const row = await db.getAccess(conn, username, nodeId);
    expect(row?.allowed_inbounds).toEqual(["reality"]);
    expect(row?.allowed_outbounds).toEqual(["niigata"]);
    expect(row?.uuids).toEqual({ niigata: "u1" });

    await db.upsertAccess(conn, username, nodeId, [], ["other"], {
      other: "u2",
    });

    const replaced = await db.getAccess(conn, username, nodeId);
    expect(replaced?.allowed_inbounds).toEqual([]);
    expect(replaced?.uuids).toEqual({ other: "u2" });
  });

  it("orders one node's access rows by username and one user's by node", async () => {
    const alice = uid("alice");
    const bob = uid("bob");
    const osaka = uid("osaka01");
    const tokyo = uid("tokyo01");
    for (const username of [alice, bob]) {
      for (const nodeId of [osaka, tokyo]) {
        await db.upsertAccess(conn, username, nodeId, [], [], {});
      }
    }

    expect(
      (await db.listAccessForNode(conn, tokyo)).map((row) => row.username),
    ).toEqual([alice, bob]);
    expect(
      (await db.listAccessForUser(conn, alice)).map((row) => row.node_id),
    ).toEqual([osaka, tokyo]);
  });

  it("deletes a user's access rows with the user", async () => {
    const username = uid("alice");
    const nodeId = uid("n");
    await makeUser(username);
    await db.upsertAccess(conn, username, nodeId, [], [], {});

    await db.deleteUser(conn, username);

    expect(await db.getUser(conn, username)).toBeNull();
    expect(await db.getAccess(conn, username, nodeId)).toBeNull();
  });

  it("scopes REALITY keys per node and rotates in place", async () => {
    const tokyo = uid("tokyo01");
    const toyama = uid("toyama01");
    await db.upsertRealityKey(conn, tokyo, "reality", "k-tokyo", 1);
    await db.upsertRealityKey(conn, toyama, "reality", "k-toyama", 2);

    expect((await db.listRealityKeys(conn, tokyo))["reality"]?.private_key).toBe(
      "k-tokyo",
    );
    expect(
      (await db.listRealityKeys(conn, toyama))["reality"]?.private_key,
    ).toBe("k-toyama");

    await db.upsertRealityKey(conn, tokyo, "reality", "new", 3);

    const keys = await db.listRealityKeys(conn, tokyo);
    expect(keys["reality"]?.private_key).toBe("new");
    expect(keys["reality"]?.created_at).toBe(3);
  });

  it("stores link-profile overrides as JSON and lists them", async () => {
    const nodeId = uid("n");
    await makeProfile(nodeId);

    const profile = await db.getLinkProfile(conn, nodeId, "cdn");
    expect(profile?.label).toBe("CDN");
    expect(profile?.overrides).toEqual({
      address: "cdn.example.com",
      port: 443,
    });
    expect(
      (await db.listLinkProfiles(conn, nodeId)).map((row) => row.id),
    ).toEqual(["cdn"]);
  });

  it("updates and deletes one link profile", async () => {
    const nodeId = uid("n");
    await makeProfile(nodeId);

    await db.updateLinkProfile(conn, {
      node_id: nodeId,
      id: "cdn",
      inbound_tag: "xhttp",
      label: "CDN Edge",
      overrides: { address: "edge.example.com" },
      created_at: 1,
    });
    expect((await db.getLinkProfile(conn, nodeId, "cdn"))?.label).toBe(
      "CDN Edge",
    );

    await db.deleteLinkProfile(conn, nodeId, "cdn");
    expect(await db.getLinkProfile(conn, nodeId, "cdn")).toBeNull();
  });
});
