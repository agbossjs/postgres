import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { endPodBackends, podApplicationName, urlNamed } from "./abandoned-backends.js";
import { createSchema, serverUrl } from "./database.js";
import { dropOnServer, dropSchemas } from "./drop-schemas.js";

/**
 * agbossjs/agboss#985 — on a real server: a pod that dies inside a transaction leaves its locks, the
 * drop of its schema waits for them; the teardown ends the connections of its own pods first.
 */
describe("agbossjs/agboss#985: a transaction left open by a pod", () => {
  const clients: pg.Client[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
  });

  /** A pod of `schema` inside a transaction holding a lock on a table of it. */
  async function podInTransaction(schema: string, url: string): Promise<void> {
    const pod = new pg.Client({ connectionString: urlNamed(url, podApplicationName(schema)) });
    clients.push(pod);
    pod.on("error", () => undefined);
    await pod.connect();
    await pod.query(
      `BEGIN; CREATE TABLE ${schema}.held (id int); INSERT INTO ${schema}.held VALUES (1)`,
    );
  }

  it("blocks the drop within its bound, until the pod's connection is ended", async () => {
    const { schema, url } = await createSchema();
    const bystander = await createSchema();
    await podInTransaction(schema, url);
    await podInTransaction(bystander.schema, bystander.url);
    const drop = dropOnServer(serverUrl());

    const blocked = await dropSchemas([schema], drop, { boundMs: 1_000 });
    expect(blocked.dropped).toBe(0);
    expect(blocked.leaked.map((leak) => leak.schema)).toEqual([schema]);
    expect(blocked.leaked[0]?.reason).toMatch(/lock timeout|statement timeout/u);

    expect(await endPodBackends(serverUrl(), [schema])).toBe(1);
    expect(await dropSchemas([schema], drop)).toEqual({ dropped: 1, leaked: [] });

    // a pod of another schema is not this teardown's to end
    expect(await endPodBackends(serverUrl(), [schema])).toBe(0);
    expect(await endPodBackends(serverUrl(), [bystander.schema])).toBe(1);
    await dropSchemas([bystander.schema], drop);
  });

  it("nothing open: nothing ended, the drop is quick", async () => {
    const { schema } = await createSchema();
    expect(await endPodBackends(serverUrl(), [schema])).toBe(0);
    expect(await dropSchemas([schema], dropOnServer(serverUrl()))).toEqual({
      dropped: 1,
      leaked: [],
    });
  });
});
