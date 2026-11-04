// agbossjs/agboss#590, #760: the broken set "leases on the caller's clock" (explorer-bites-caller-clock.test.ts).
import { callerClockSet } from "./explorer-bites.sets.js";

callerClockSet();
