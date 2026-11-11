import {
  ApplicationContext,
  EXECUTION_ID_STORE,
  Injectable,
  StoreClock,
  type ExecutionIdentity,
  type ExecutionIdStore,
  type StoreDescriptor,
} from "@agboss/core";
import { PostgresConnection, PostgresExecutionLeaseRepository } from "../../src/index.js";

/**
 * Leases on a coordination backend, as `@agboss/redis`'s are (agbossjs/agboss#891 AC3): declared
 * `backend: "redis"`, keeping no execution ids of their own — the application gives them a durable
 * store under `EXECUTION_ID_STORE`. Only its declarations matter at assembly (the leases themselves
 * are the PostgreSQL ones underneath).
 */
@Injectable({ deps: [PostgresConnection, StoreClock, ApplicationContext, EXECUTION_ID_STORE] })
export class CoordinationLeases extends PostgresExecutionLeaseRepository {
  static override readonly store: StoreDescriptor = { backend: "redis" };

  constructor(
    connection: PostgresConnection,
    clock: StoreClock,
    applicationContext: ApplicationContext,
    private readonly ids: ExecutionIdStore,
  ) {
    super(connection, clock, applicationContext);
  }

  override claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    return this.ids.claimExecutionId(identity);
  }
}
