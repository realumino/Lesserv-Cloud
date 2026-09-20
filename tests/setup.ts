/**
 * Vitest setup file: create the production schema in the test D1.
 *
 * WHY here and not in a test: every tier may read or write the database, so
 * the schema is a precondition for the whole run. Migrations are read by
 * the vitest config (`readD1Migrations`) and passed as the TEST_MIGRATIONS
 * binding; `applyD1Migrations` records what it applied, so this is
 * idempotent even though the setup file runs for every test file.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { testMigrations } from "./helpers";

await applyD1Migrations(env.DB, testMigrations());
