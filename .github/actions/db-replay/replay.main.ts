import { resolve } from "node:path";

import { entry, inputs, publish, required } from "../_lib/annotations.ts";
import { replayGate } from "./replay.ts";

await entry(async () => {
  const read = inputs("database-image", "from-empty", "replayed", "project");

  // The database the calling job declared, mapped into this step by the action
  // from the value that job read before the graded repo ran — action.yml says
  // why it is an input there rather than whatever the environment now holds.
  const url = required("DATABASE_URL", "the calling job must set it for the database it declared");

  publish(
    await replayGate({
      // Named rather than inherited: this gate runs in the action's own
      // checkout, so the project is a path it is handed. Resolved because the
      // default is `.` against the workspace, and every diagnostic below
      // quotes it.
      root: resolve(read["project"]),
      url,
      image: read["database-image"],
      fromEmpty: read["from-empty"],
      replayed: read["replayed"],
    }),
  );
});
