import { describe, expect, it } from "vitest";
import { withoutPasswords } from "../../src/redaction.js";

describe("agbossjs/agboss#891: withoutPasswords — no password of a connection string is printed", () => {
  it.each([
    ["postgres://u:secret@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p@ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p:ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p%40ss@h:5432/db", "postgres://u:***@h:5432/db"],
    [
      "mongodb+srv://u:secret@cluster.example.net/?w=majority",
      "mongodb+srv://u:***@cluster.example.net/?w=majority",
    ],
    ["postgres://h/db?user=u&password=secret&x=1", "postgres://h/db?user=u&password=***&x=1"],
    ["postgres://h/db?sslpassword=secret", "postgres://h/db?sslpassword=***"],
    ["postgres://u:p@ss@h1:5432,h2:5432/db", "postgres://u:***@h1:5432,h2:5432/db"],
    [
      "mongodb://u:p@ss@h1:27017,h2:27017/db?replicaSet=rs0",
      "mongodb://u:***@h1:27017,h2:27017/db?replicaSet=rs0",
    ],
    [
      "failed: connect postgres://u:secret@h/db (refused)",
      "failed: connect postgres://u:***@h/db (refused)",
    ],
  ])("%s", (text, masked) => {
    expect(withoutPasswords(text)).toBe(masked);
    expect(withoutPasswords(text)).not.toMatch(/secret|p@ss|p:ss|p%40ss/u);
  });

  it("a text with no connection string is kept as it is", () => {
    expect(withoutPasswords("schema t_1 is at migration 29")).toBe("schema t_1 is at migration 29");
    expect(withoutPasswords("mail me at u@h, ok")).toBe("mail me at u@h, ok");
  });
});
