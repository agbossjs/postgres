import pg from "pg";
import { pinnedUrl } from "./pinned-url.js";

/**
 * Every test of this repository runs against a real PostgreSQL: `AGBOSS_POSTGRES_TEST_URL` names
 * it. Without it — or when it does not answer — the run fails here, before any test, saying how
 * to start one; a test is never skipped.
 */
const HOW_TO = `start one and export its URL, e.g.
  docker run -d --name agboss-postgres -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
  export AGBOSS_POSTGRES_TEST_URL=postgres://postgres:pw@localhost:5432/postgres`;

export default async function requirePostgres(): Promise<void> {
  const url = process.env.AGBOSS_POSTGRES_TEST_URL;
  if (url === undefined || url === "")
    throw new Error(`AGBOSS_POSTGRES_TEST_URL is not set: the tests need a PostgreSQL — ${HOW_TO}`);
  // agbossjs/agboss#989: the host the server answers on, so no connection can be made to itself;
  // the test files' workers start after this setup and inherit the pinned URL
  const pinned = await pinnedUrl(url);
  process.env.AGBOSS_POSTGRES_TEST_URL = pinned;
  const client = new pg.Client({ connectionString: pinned });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (error) {
    throw new Error(`AGBOSS_POSTGRES_TEST_URL does not answer (${String(error)}) — ${HOW_TO}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
