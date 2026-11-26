/**
 * agbossjs/agboss#1260 (#1104): the refusal a start with `SchemaSetup.MigrateOnStart` raises names
 * the connection settings' switch and the migrate command's flag, so an operator knows what to set
 * (the environment is no source of the connection since agbossjs/agboss#1324).
 */
import { describe, expect, it } from "vitest";
import { PostgresLiveLeasesError } from "../../src/index.js";

describe("#1260: PostgresLiveLeasesError's message names the way to migrate anyway", () => {
  const message = new PostgresLiveLeasesError({ count: 2, holders: ["pod-a", "pod-b"] }).message;

  it("the settings' allowLiveLeases, and no environment field any more", () => {
    expect(message).toContain("allowLiveLeases: true");
    expect(message).not.toContain("postgresAllowLiveLeases");
  });

  it("the command's flag, and what the refusal found", () => {
    expect(message).toContain("--allow-live-leases");
    expect(message).toContain("2 live execution lease(s) held by pod-a, pod-b");
    expect(message).toContain("stop every old instance");
  });
});
