import { describe, expect, it } from "vitest";
import { isOneStatement } from "../../src/connection/known-failure.js";

/**
 * postgres#113: a server's abort proves a write did not take effect only for one statement that
 * cannot commit inside itself — several statements may have committed some, a procedure or an
 * anonymous block may commit in its body.
 */
describe("isOneStatement", () => {
  it.each([
    "UPDATE t SET v = 1 WHERE id = 1",
    "UPDATE t SET v = 1 WHERE id = 1;",
    "UPDATE t SET v = 1 WHERE id = 1 ; \n",
    // the words of a procedure or a block inside a statement, not at its start
    "UPDATE t SET note = 'do' WHERE kind = 'call'",
    "SELECT 1 AS do",
  ])("%j is one statement", (sql) => {
    expect(isOneStatement(sql)).toBe(true);
  });

  it.each([
    "UPDATE t SET v = 1; UPDATE t SET v = 2",
    "SELECT 1;SELECT 2;",
    "CALL settle(1)",
    "  call settle(1)",
    "DO $$ BEGIN PERFORM 1; END $$",
    "\ndo $$ BEGIN NULL; END $$",
  ])("%j is not", (sql) => {
    expect(isOneStatement(sql)).toBe(false);
  });
});
