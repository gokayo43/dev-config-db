/**
 * What an allowlist input is, for every gate here that has one: the entries a
 * gate compares against, plus what is wrong with the input itself.
 *
 * **This is a checked-in copy of the allowlist half of dev-config's
 * `.github/actions/_lib/gate.ts` at the pinned SHA** — `REASON`, `entriesIn`,
 * `Allowlist`, `allowlistFrom` and `deadEntries`, theirs with the one delta
 * named below. It is a copy for the reason `annotations.ts` gives at length:
 * an action runs from a checkout with no `node_modules` above it, and
 * `.github/` sits outside dev-config's `files` allowlist, so there is no import
 * that reaches the original. dev-config#69 is where publishing it in a
 * reachable form is argued, and CLAUDE.md's "It only adds" rule carries the
 * carve-out that lets this file exist. A bug fixed there is a bug still here
 * until somebody carries it over.
 *
 * Deltas from upstream, both about what this repo has rather than about the
 * rule:
 *   * a problem is a plain string rather than their `Problem`, the same delta
 *     `annotations.ts` carries and for the same reason: every problem this
 *     repo's gates raise is about a database rather than about a line of the
 *     tree, and `file=`/`line=` on an annotation pointing at nothing is dropped
 *     by GitHub in silence.
 *   * the lists are `readonly`, since nothing here mutates one.
 */

/** The separator oxlint uses between a suppression and its reason, and every allowlist here follows it. */
export const REASON = " -- ";

/**
 * One entry per line — not space-separated, because an entry contains spaces: a
 * quoted SQL identifier, and the reason it carries. The reason is prose, prose
 * contains commas, and an entry that ended at one would be graded as two: a
 * subject stripped of the reason written for it, and half a sentence read as a
 * subject nobody wrote. Two diagnostics, both true of an input nobody typed.
 */
function entriesIn(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * A gate takes one of these whole rather than its `entries`: the reason on each
 * entry is enforced by reporting `problems`, and a signature that accepted the
 * list alone would let a caller typecheck while dropping that half.
 */
export interface Allowlist {
  /** Each entry with its reason stripped: the part a gate compares against. */
  readonly entries: readonly string[];
  /**
   * The subjects behind `problems`, so that a gate with a second rule about an
   * entry can leave the ones already refused alone: an entry the reader is
   * being sent back to anyway earns one diagnostic, not two.
   */
  readonly unreasoned: ReadonlySet<string>;
  /** One per entry that waives something and says nothing about why. */
  readonly problems: readonly string[];
}

/**
 * An allowlist input, as the list a gate compares against plus what is wrong
 * with it. Every entry carries `-- why`, the same price a lint directive pays:
 * an exemption whose reason nobody had to write is one nobody has to justify,
 * and a year later it is indistinguishable from a bug someone silenced.
 *
 * A reasonless entry still waives its subject — the gate fails on the missing
 * reason, and reporting the waived subject as well would be two diagnostics for
 * one mistake.
 */
export function allowlistFrom(value: string, input: string): Allowlist {
  const read = entriesIn(value).map((item) => {
    const [subject = "", ...reason] = item.split(REASON);
    return { subject: subject.trim(), reasoned: reason.join(REASON).trim() !== "" };
  });

  const unreasoned = read.filter(({ reasoned }) => !reasoned).map(({ subject }) => subject);

  return {
    entries: read.map(({ subject }) => subject),
    unreasoned: new Set(unreasoned),
    problems: unreasoned.map(
      (subject) =>
        `${input} waives ${subject} without saying why — write '${subject}${REASON}<reason>', the same price a lint directive pays`,
    ),
  };
}

/**
 * The waivers standing for nobody, and which of the two ways each got there.
 *
 * The DATETIME gate is what this serves: its entries ARE the subjects it
 * grades, so they can be subtracted from a set of them.
 *
 * `live` is what the gate still grades: a subject in it is a waiver doing its
 * job. `known` is everything the gate can see at all, and the difference
 * between the two is the difference between an entry to drop and a name to fix
 * — sending the first case name-hunting is how a retired rule costs every
 * consumer an afternoon.
 *
 * An entry with no reason is asked none of this: its author is going back to
 * that line regardless, and one mistake earns one diagnostic.
 */
export function deadEntries(
  allowlist: Allowlist,
  live: ReadonlySet<string>,
  known: ReadonlySet<string>,
  message: (subject: string, stillKnown: boolean) => string,
): string[] {
  return [...new Set(allowlist.entries)]
    .filter((subject) => !live.has(subject) && !allowlist.unreasoned.has(subject))
    .map((subject) => message(subject, known.has(subject)));
}
