import { resolve } from "node:path";

import { entry, inputs, publish } from "../_lib/annotations.ts";
import { BOOT_SECONDS, bootGate, healthUrlFrom, startCommandFrom } from "./boot.ts";

await entry(async () => {
  const read = inputs("start-command", "health-url", "app-log", "project");

  publish(
    await bootGate({
      // Named rather than inherited: this gate runs in the action's own
      // checkout — action.yml says why — so the project the app starts in is a
      // path it is handed. Resolved because the default is `.` against the
      // workspace, and the diagnostics quote it.
      root: resolve(read["project"]),
      command: startCommandFrom(read["start-command"]),
      // Refused here, before anything is started. The probe step after this
      // one takes the same URL and does not check it again.
      url: healthUrlFrom(read["health-url"]),
      log: read["app-log"],
      // The module's own number rather than an input. Nothing a caller could
      // say about how long its app takes to start is a fact this gate wants to
      // take on trust — boot.ts carries the bound and the argument for it.
      seconds: BOOT_SECONDS,
    }),
  );
});
