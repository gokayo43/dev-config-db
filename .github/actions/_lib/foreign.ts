/**
 * A document nobody here wrote, read one key at a time.
 *
 * Everything the gates in this repo grade is foreign: another repo's
 * `package.json`, a workflow's YAML, a row a server answered with. None of it
 * has a schema this repo can hold — the keys are whatever that repo wrote, and
 * a modelled type would have to be every valid and invalid one of them at once
 * while claiming exactly what has not been checked yet.
 *
 * So the shape is refused at the read instead, and every gate goes through
 * these five rather than restating the narrowing. The alias below is the one
 * escape hatch in the tree, in the one module whose job is to hold it.
 *
 * **This is a checked-in copy of the narrowing half of dev-config's
 * `.github/actions/_lib/gate.ts` at the pinned SHA**, for the reason
 * `annotations.ts` gives at length and CLAUDE.md carries as a carve-out: an
 * action runs from a checkout with no node_modules above it, so there is no
 * import that reaches the original. dev-config#69 is where ending that is
 * argued.
 *
 * Deltas from upstream, all cosmetic — nothing here behaves differently:
 *   * `Foreign` is their `ConfigObject`, under a name that says whose document
 *     it is rather than what kind of file it came from, since this repo reads
 *     database rows through it as well as configs.
 *   * `isForeign` is their `isObject`, renamed to match.
 *   * `kindOf` says "a list" where theirs says "an array", because every
 *     diagnostic here that uses it is about a query answer or a YAML node.
 *   * `mapAt` and `textAt` are this repo's own: upstream reads fields through
 *     `record()` at each call site, and two readers here descend several levels
 *     of a document at a time.
 *   * `isList` is theirs verbatim, docblock included.
 */

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the boundary this module exists to be: a mapping whose keys are another author's, read through the functions below and never indexed raw
export type Foreign = Record<string, unknown>;

/**
 * Whether there is a mapping here at all. A boundary that cannot say anything
 * true about a `null` refuses it rather than reading a field off it.
 */
export function isForeign(value: unknown): value is Foreign {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether there is a list here at all. Its own function because `Array.isArray`
 * narrows an `unknown` to `any[]`, and every element read off that is an `any`
 * — which is the thing a caller reaching for this is trying to stop having.
 */
export function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** A mapping under `key`, or an empty one — for a reader descending through a document. */
export function mapAt(node: unknown, key: string): Foreign {
  if (!isForeign(node)) return {};
  const held = node[key];
  return isForeign(held) ? held : {};
}

/** Text under `key`, or nothing there. Absent and "not text" are one answer: neither is a string. */
export function textAt(node: unknown, key: string): string | undefined {
  if (!isForeign(node)) return undefined;
  const held = node[key];
  return typeof held === "string" ? held : undefined;
}

/** What was there instead, for a diagnostic that has to say what it refused. */
export function kindOf(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (isList(value)) return "a list";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
