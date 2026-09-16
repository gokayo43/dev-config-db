// oxlint-disable-next-line no-restricted-imports -- the per-case hook this file exists to register: an app writes its pid into a project a case made, and both have to go before the next case starts. `await using` in the case cannot reach either, since what a case holds is a path it handed to a gate rather than a value
import { afterAll, afterEach } from "bun:test";

import { removeCheckouts } from "./action-step.ts";
import { stopApps } from "./app.ts";
import { stop } from "./servers.ts";
import { removeRoots } from "./tree.ts";

/**
 * The hooks that have to outlive every test file, registered where `bun test`
 * runs them for the whole run rather than at the end of whichever file imported
 * their module first. That distinction is the difference between a shared
 * server and a trap, and between a suite that cleans up after itself and one
 * that leaves an app per case running and a project per case on disk —
 * `servers.ts`, `app.ts` and `tree.ts` each say so where the work is. Importing
 * them here starts nothing.
 *
 * The order inside the per-case hook is load-bearing: an app writes its pid
 * into the project a case made, so the app has to be taken down before the
 * project is removed.
 */
afterEach(async () => {
  await stopApps();
  await removeRoots();
  await removeCheckouts();
});

afterAll(stop);
