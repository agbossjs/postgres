/** The types of `mutation-shards.mjs`, for `vitest.mutation.config.ts`. */
export interface MutationShard {
  readonly mutate: readonly string[];
  readonly tests: readonly string[];
  /** Stryker's `timeoutMS` for the shard's mutants: above the shard's whole run (agbossjs/agboss#1367). */
  readonly timeoutMS: number;
  /** Files of `tests` left out. */
  readonly exclude?: readonly string[];
}
export declare const SHARDS: Readonly<Record<string, MutationShard>>;
export declare function chosenShard(): MutationShard & { readonly name: string };
export declare const NON_SHARDED_SRC: ReadonlySet<string>;
