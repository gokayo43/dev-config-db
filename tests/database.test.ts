import { describe, expect, test } from "bun:test";

import type { Foreign } from "../.github/actions/_lib/foreign.ts";
import { rowsFrom, textIn } from "../.github/actions/db-replay/database.ts";

import { PRODUCTS, server } from "./servers.ts";

/**
 * The refusals a server's answer meets before any gate reads it. Each case's
 * reason is the diagnostic: a red run is read by a person who never saw the
 * answer, so the message has to say what was there instead of what the gate
 * needed.
 */

const WHERE = "row 3 of app's catalogue";

/** What a server can hand back under a column's alias, and what the refusal has to call it. */
const NOT_TEXT: readonly (readonly [string, Foreign, string])[] = [
  ["a column the query never aliased", {}, "absent"],
  ["a NULL", { name: null }, "null"],
  ["a JSON array the driver parsed", { name: [1, 2] }, "a list"],
  ["a JSON object the driver parsed", { name: { a: 1 } }, "an object"],
  ["a number", { name: 7 }, "a number"],
];

for (const [answered, row, kind] of NOT_TEXT) {
  test(`a field holding ${answered} is refused as ${kind} rather than text`, () => {
    expect(() => textIn(row, "name", WHERE)).toThrow(
      `${WHERE} has name as ${kind} rather than text`,
    );
  });
}

for (const product of PRODUCTS) {
  describe(product.name, () => {
    test("a query answering one result set per statement is refused, naming the query", async () => {
      const query = "select 1 as a; select 2 as b";
      const refused = await rowsFrom(await server(product), query, []).catch(
        (error: unknown) => error,
      );
      expect(refused).toEqual(new Error(`row 0 is a list rather than a row — ${query}`));
    }, 180_000);
  });
}
