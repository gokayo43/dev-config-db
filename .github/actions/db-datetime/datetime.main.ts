import { allowlistFrom } from "../_lib/allowlist.ts";
import { entry, inputs, publish, required } from "../_lib/annotations.ts";
import { datetimeGate } from "./datetime.ts";

await entry(async () => {
  const read = inputs("datetime-allowlist");

  // The database the calling job declared, mapped into this step by the action
  // from the value that job read before the graded repo ran — the same value
  // the replay step migrated, and action.yml says why it is an input there
  // rather than whatever the environment now holds.
  const url = required(
    "DATABASE_URL",
    "this gate reads the catalogue of the database the replay built",
  );

  publish(await datetimeGate(url, allowlistFrom(read["datetime-allowlist"], "datetime-allowlist")));
});
