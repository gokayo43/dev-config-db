import { expect, test } from "bun:test";

import {
  ENDPOINT as PUBLISHED_ENDPOINT,
  EVERY_METHOD as PUBLISHED_EVERY_METHOD,
  type Route as PublishedRoute,
  type RouteLog as PublishedRouteLog,
  type Served as PublishedServed,
} from "@gokayo43/dev-config/route-log";

import {
  ENDPOINT,
  EVERY_METHOD,
  type Route,
  type RouteLog,
  type Served,
} from "../.github/actions/db-serving/route-log.ts";

/**
 * The one checked-in copy in this repo whose original is reachable from
 * somewhere, and this is that somewhere.
 *
 * `route-log.ts` under `.github/actions` is a copy for the reason every copy
 * here is one — an action runs from a checkout with no `node_modules` above it
 * — but unlike `annotations.ts` and `foreign.ts`, dev-config publishes this one:
 * it is an export of theirs, `@gokayo43/dev-config/route-log`, because the app
 * end of the contract imports it. A test resolves node_modules normally, so the
 * two ends can be held together here.
 *
 * A protocol whose two ends disagree is a floor grading a payload nobody sends.
 * The strings are compared at runtime; the three shapes are compared by the
 * assignments below, each of which the typechecker refuses if either side has
 * grown, lost or changed a field.
 */

test("the endpoint and the catch-all method are dev-config's own", () => {
  expect(ENDPOINT).toBe(PUBLISHED_ENDPOINT);
  expect(EVERY_METHOD).toBe(PUBLISHED_EVERY_METHOD);
});

test("a payload built against the published protocol is the payload this gate reads", () => {
  const published: PublishedRouteLog = {
    routeTable: [{ method: PUBLISHED_EVERY_METHOD, path: "/api/events" }],
    counts: [{ method: "GET", path: "/api/events", count: 2 }],
  };

  // Both directions, because assignability one way is a shape that has grown a
  // field and the other way is one that has lost one.
  const here: RouteLog = published;
  const back: PublishedRouteLog = here;
  const route: Route = published.routeTable[0] ?? { method: "", path: "" };
  const theirs: PublishedRoute = route;
  const served: Served = published.counts[0] ?? { method: "", path: "", count: 0 };
  const theirServed: PublishedServed = served;

  expect(back).toEqual(published);
  expect(theirs).toEqual({ method: "ALL", path: "/api/events" });
  expect(theirServed.count).toBe(2);
});
