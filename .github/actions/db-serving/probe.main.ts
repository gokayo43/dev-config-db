import { resolve } from "node:path";

import { entry, inputs, publish } from "../_lib/annotations.ts";
import { probeGate } from "./probe.ts";

await entry(async () => {
  const read = inputs("probe-command", "probe-timeout", "health-url", "project");

  publish(
    await probeGate({
      // Named rather than inherited, for the reason action.yml gives: the gate
      // runs in the action's own checkout, and the probe is the repo's own
      // command, run in the repo's own project.
      root: resolve(read["project"]),
      command: read["probe-command"],
      // The same URL the boot step polled, from the same input. A second way of naming the app would be a second thing to get
      // wrong about which app the probe was talking to — and the boot step has
      // already refused a value that is not one.
      url: read["health-url"],
      // Unparsed: the gate reads the bound out of it, and needs to be able to
      // tell "no bound named" from the number that stands in for one.
      timeout: read["probe-timeout"],
    }),
  );
});
