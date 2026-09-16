import { dirname } from "node:path";

import {
  type Foreign,
  isForeign,
  isList,
  kindOf,
  mapAt,
  textAt,
} from "../.github/actions/_lib/foreign.ts";

/**
 * The wrapper as both suites here read it. Two of them ask about the same file
 * for different reasons — `wrapper-inputs.test.ts` grades what it declares and
 * hands on, `servers.ts` needs the server the shipped job actually runs — and
 * the file is the one place either of them should be reading that from.
 */
export const root = dirname(import.meta.dir);

export const WRAPPER = ".github/workflows/check.yml";

/**
 * The wrapper, parsed and narrowed here rather than by each reader. A workflow
 * is a mapping at its top level; anything else is a file that has stopped being
 * one, which is worth saying once at the read instead of coming out as an empty
 * answer to every question below it.
 */
export async function wrapperDocument(): Promise<Foreign> {
  const document: unknown = Bun.YAML.parse(await Bun.file(`${root}/${WRAPPER}`).text());
  if (!isForeign(document)) {
    throw new Error(`${WRAPPER} did not parse as a workflow — it is ${kindOf(document)}`);
  }
  return document;
}

/**
 * Every string anywhere in a document, which is where a path, an expression or
 * a command can be written.
 *
 * Here rather than in the suite that wants it, because reading a workflow is
 * what this module is for and the walk needs the `unknown` this file is already
 * the boundary for.
 */
export function stringsIn(document: unknown): string[] {
  if (typeof document === "string") return [document];
  if (isList(document)) return document.flatMap((node) => stringsIn(node));
  if (!isForeign(document)) return [];
  return Object.values(document).flatMap((node: unknown) => stringsIn(node));
}

/** The input a consumer declares its server with, and the one input the suite reads a value out of. */
export const SERVER_IMAGE = "database-image";

/**
 * Every image a job of the wrapper declares as a service — read at the one
 * depth a service image sits at, never walked. A walk would take any string
 * that looks like a reference with it, including the expression the server now
 * reaches its steps as, and every question asked of this would then be asking
 * about that.
 */
export async function serviceImages(): Promise<string[]> {
  return Object.values(mapAt(await wrapperDocument(), "jobs")).flatMap((job) =>
    Object.values(mapAt(job, "services")).flatMap((service) => {
      const image = textAt(service, "image");
      return image === undefined ? [] : [image];
    }),
  );
}

/**
 * The server a consumer who declares nothing gets, read off the wrapper's own
 * declaration.
 *
 * Refused rather than defaulted here: a suite cannot invent the server it
 * grades against, and the whole worth of driving these gates against a real
 * server is that it is the one the shipped job runs.
 */
export async function defaultServerImage(): Promise<string> {
  const declared = mapAt(mapAt(mapAt(await wrapperDocument(), "on"), "workflow_call"), "inputs")[
    SERVER_IMAGE
  ];
  const found = textAt(declared, "default");
  if (found === undefined || found === "") {
    throw new Error(
      `${WRAPPER} declares no default for ${SERVER_IMAGE} — the suite drives these gates against the server a consumer who writes nothing gets, and cannot find it`,
    );
  }
  return found;
}
