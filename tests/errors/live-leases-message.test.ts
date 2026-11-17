/**
 * agbossjs/agboss#1260 (#1104): the refusal a start with `SchemaSetup.MigrateOnStart` raises names
 * the environment's switch as well as the settings' one, so an operator who configures through the
 * application's environment knows what to set.
 */
import { describe, expect, it } from "vitest";
import { PostgresLiveLeasesError } from "../../src/index.js";

describe("#1260: PostgresLiveLeasesError's message names the way to migrate anyway", () => {
  const message = new PostgresLiveLeasesError({ count: 2, holders: ["pod-a", "pod-b"] }).message;

  it("the settings' allowLiveLeases and the environment's postgresAllowLiveLeases", () => {
    expect(message).toContain("allowLiveLeases: true");
    expect(message).toContain("postgresAllowLiveLeases");
  });

  it("the command's flag, and what the refusal found", () => {
    expect(message).toContain("--allow-live-leases");
    expect(message).toContain("2 live execution lease(s) held by pod-a, pod-b");
    expect(message).toContain("stop every old instance");
  });
});
