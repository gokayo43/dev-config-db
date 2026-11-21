import { resolve } from "node:path";

import { entry, inputs, publish, required } from "../_lib/annotations.ts";
import { upgradeGate } from "./upgrade.ts";

await entry(async () => {
  const read = inputs("database-image", "base-ref", "before", "upgraded", "project");

  // The database the calling job declared, mapped into this step by the action
  // from the value that job read before the graded repo ran — the same database
  // the replay step built from empty, and what an upgrade has to arrive at.
  const url = required(
    "DATABASE_URL",
    "this gate compares the schema an upgrade reaches against the one the replay built",
  );

  publish(
    await upgradeGate({
      // Named rather than inherited: this gate runs in the action's own
      // checkout, so the project is a path it is handed.
      root: resolve(read["project"]),
      url,
      image: read["database-image"],
      event: { baseRef: read["base-ref"], before: read["before"] },
      upgraded: read["upgraded"],
    }),
  );
});
