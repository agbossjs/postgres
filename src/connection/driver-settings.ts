import type { DriverTimeouts, ResolvedSettings } from "@agboss/core/stores";
import { SchemaSetup } from "@agboss/core/stores";
import { z } from "zod";
import { PostgresSettingsError } from "../errors.js";
import { checkedSchemaOf, checkedTimeoutOf, type PostgresConnectionSettings } from "./settings.js";

/**
 * The settings `PostgresDriver` resolved (agbossjs/agboss#1321f): its options with the `secret(…)`
 * of the URL revealed, the durations in `Milliseconds` (`DriverTimeouts`), read once at start. What
 * `PostgresConnection` makes its pool of.
 */

/** A `Secret` of the resolved settings: only `reveal()` gives its value. */
const Revealing = z.custom<{ reveal(): string }>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "reveal" in value &&
    typeof value.reveal === "function",
  { error: "the driver's url must be a secret(…)" },
);

const Resolved = z.object({
  kind: z.literal("postgres"),
  url: Revealing,
  schema: z.string().optional(),
  poolSize: z.number().int().min(1).optional(),
  schemaSetup: z.enum(SchemaSetup).optional(),
  watchLiveness: z.number().optional(),
  commandTimeout: z.number().optional(),
  idleInTransactionTimeout: z.number().optional(),
});

/** What the driver's options `timeouts` hold, as settings fields. */
export const timeoutSettingsOf = (timeouts: DriverTimeouts | undefined): Record<string, number> =>
  Object.fromEntries(
    Object.entries(timeouts ?? {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );

/** The connection settings of a driver's resolved settings; `PostgresSettingsError` for one that is none. */
export function settingsOfResolved(resolved: ResolvedSettings): PostgresConnectionSettings {
  const parsed = Resolved.safeParse(resolved);
  if (!parsed.success)
    throw new PostgresSettingsError({
      message: `the PostgreSQL driver's settings are wrong — ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    });
  const { url: secret, watchLiveness, commandTimeout, idleInTransactionTimeout } = parsed.data;
  const url = secret.reveal();
  if (url.length === 0) throw new PostgresSettingsError({ message: "the driver's url is empty" });
  return {
    url,
    poolSize: parsed.data.poolSize,
    schema: checkedSchemaOf(parsed.data.schema),
    schemaSetup: parsed.data.schemaSetup,
    watchLivenessSeconds:
      watchLiveness === undefined ? undefined : Math.round(watchLiveness / 1000),
    commandTimeout: checkedTimeoutOf("commandTimeout", commandTimeout),
    idleInTransactionTimeout: checkedTimeoutOf(
      "idleInTransactionTimeout",
      idleInTransactionTimeout,
    ),
  };
}
