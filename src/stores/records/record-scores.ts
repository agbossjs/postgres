import { z } from "zod";
import { changesOf, firstRowOf, rowsOf, type Queryable } from "../../connection/query.js";
import type { StoredConfigSnapshot, StoredVersionScore } from "./record-rows.js";

/** Quality scores of records, the summary per prompt version, and the config snapshots (#78). */

const MeanRow = z.object({ mean: z.number().nullable() });

const VersionScoreRow = z.object({
  prompt_version: z.string(),
  records: z.number(),
  scored: z.number(),
  mean_score: z.number().nullable(),
  cost_usd: z.number(),
});

const SnapshotRow = z.object({
  version: z.string(),
  hash: z.string(),
  snapshot: z.string(),
  first_seen: z.date(),
});

export async function saveScore(
  database: Queryable,
  recordId: string,
  judge: string,
  score: number,
  now: Date,
): Promise<void> {
  await changesOf(
    database,
    "INSERT INTO agboss_execution_scores (record_id, judge, score, created_at) VALUES ($1, $2, $3, $4)",
    [recordId, judge, score, now],
  );
}

/** The mean score of the records' scores; `null` when none is scored. */
export async function meanScoreOf(
  database: Queryable,
  recordIds: readonly string[],
): Promise<number | null> {
  const row = await firstRowOf(
    database,
    "SELECT avg(score) AS mean FROM agboss_execution_scores WHERE record_id = ANY($1::text[])",
    [recordIds],
  );
  return MeanRow.parse(row).mean;
}

/** Per prompt version, in the order first seen: records, scored ones, mean score, total cost. */
const SUMMARY = `SELECT r.prompt_version, count(DISTINCT r.id)::integer AS records,
    count(s.score)::integer AS scored, avg(s.score) AS mean_score,
    (SELECT coalesce(sum(x.cost_usd), 0) FROM agboss_execution_records x
      WHERE x.workflow = r.workflow AND x.prompt_version = r.prompt_version
      AND x.status <> 'running') AS cost_usd
  FROM agboss_execution_records r LEFT JOIN agboss_execution_scores s ON s.record_id = r.id
  WHERE r.workflow = $1 AND r.status <> 'running'
  GROUP BY r.workflow, r.prompt_version ORDER BY min(r.seq)`;

export async function versionScoresOf(
  database: Queryable,
  workflow: string,
): Promise<StoredVersionScore[]> {
  const rows = await rowsOf(database, SUMMARY, [workflow]);
  return rows.map((row) => {
    const r = VersionScoreRow.parse(row);
    return {
      promptVersion: r.prompt_version,
      terns: r.records,
      scored: r.scored,
      meanScore: r.mean_score,
      costUsd: r.cost_usd,
    };
  });
}

/**
 * Keeps the snapshot the first time; `drift` when the version already has another hash of the
 * same length (a hash of another length is of an older hashing scheme: not comparable).
 */
export async function rememberConfig(
  database: Queryable,
  workflow: string,
  version: string,
  hash: string,
  snapshot: string,
  now: Date,
): Promise<{ readonly drift: boolean }> {
  const other = await firstRowOf(
    database,
    `SELECT 1 FROM agboss_config_versions WHERE workflow = $1 AND version = $2 AND hash <> $3
     AND length(hash) = length($3)`,
    [workflow, version, hash],
  );
  await changesOf(
    database,
    `INSERT INTO agboss_config_versions (workflow, version, hash, snapshot, first_seen)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [workflow, version, hash, snapshot, now],
  );
  return { drift: other !== undefined };
}

export async function configSnapshotsOf(
  database: Queryable,
  workflow: string,
  version: string,
): Promise<StoredConfigSnapshot[]> {
  const rows = await rowsOf(
    database,
    `SELECT version, hash, snapshot, first_seen FROM agboss_config_versions
     WHERE workflow = $1 AND version = $2 ORDER BY first_seen`,
    [workflow, version],
  );
  return rows.map((row) => {
    const r = SnapshotRow.parse(row);
    return {
      version: r.version,
      hash: r.hash,
      snapshot: r.snapshot,
      firstSeen: r.first_seen.toISOString(),
    };
  });
}
