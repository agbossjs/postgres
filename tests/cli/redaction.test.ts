import { describe, expect, it } from "vitest";
import { withoutPasswords } from "../../src/redaction.js";

/** The same tests as `@agboss/mongodb`'s (agbossjs/agboss#891): keep both files identical. */
describe("agbossjs/agboss#891: withoutPasswords — no password of a connection string is printed", () => {
  it.each([
    ["postgres://u:secret@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p@ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p/ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p:ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p%40ss@h:5432/db", "postgres://u:***@h:5432/db"],
    ["postgres://u:p#ss@h/db", "postgres://u:***@h/db"],
    ["postgres://u:p?ss@h/db", "postgres://u:***@h/db"],
    [
      "mongodb+srv://u:secret@cluster.example.net/?w=majority",
      "mongodb+srv://u:***@cluster.example.net/?w=majority",
    ],
    ["postgres://u:p@ss@h1:5432,h2:5432/db", "postgres://u:***@h1:5432,h2:5432/db"],
    [
      "mongodb://u:p@ss@h1:27017,h2:27017/db?replicaSet=rs0",
      "mongodb://u:***@h1:27017,h2:27017/db?replicaSet=rs0",
    ],
    ["postgres://h/db?user=u&password=secret&x=1", "postgres://h/db?user=u&password=***&x=1"],
    ["postgres://h/db?sslpassword=secret", "postgres://h/db?sslpassword=***"],
    ["mongodb://h/db?pass=secret#x", "mongodb://h/db?pass=***#x"],
    [
      "from postgres://u:secret@h/a to mongodb://v:secret@g/b",
      "from postgres://u:***@h/a to mongodb://v:***@g/b",
    ],
    [
      "failed: connect postgres://u:secret@h/db (refused)",
      "failed: connect postgres://u:***@h/db (refused)",
    ],
  ])("%s", (text, masked) => {
    expect(withoutPasswords(text)).toBe(masked);
    expect(withoutPasswords(text)).not.toMatch(/secret|p@ss|p\/ss|p:ss|p%40ss|p#ss|p\?ss/u);
  });

  it("a text with no connection string is kept as it is", () => {
    expect(withoutPasswords("schema t_1 is at migration 29")).toBe("schema t_1 is at migration 29");
    expect(withoutPasswords("mail me at u@h, ok")).toBe("mail me at u@h, ok");
  });

  it("a random printable password never appears: 500 seeded draws", () => {
    const printable = Array.from({ length: 94 }, (_, at) => String.fromCodePoint(33 + at)).join("");
    let seed = 891;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let draw = 0; draw < 500; draw += 1) {
      const length = 8 + (next() % 16);
      const password = Array.from({ length }, () => printable[next() % printable.length]).join("");
      const masked = withoutPasswords(`connect mongodb://user:${password}@host:1/db failed`);
      expect(masked).not.toContain(password);
    }
  });
});
