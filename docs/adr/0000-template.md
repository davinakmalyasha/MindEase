# ADR-NNNN: <the decision, stated as one sentence>

<!--
Filename: NNNN-kebab-case-title.md
Status:    proposed | accepted | superseded by ADR-NNNN
Date:      YYYY-MM

Keep this template's section order. The three existing records (0001, 0002,
0003) all follow it, and consistency is most of the value: a reader who has
read one ADR knows where to look in the next, and a reviewer can diff two
decisions section by section.
-->

- Status: proposed
- Date: YYYY-MM

## Context

<!--
The forces, not the solution. What is true today, what makes the obvious
approach fail, and what constraints are actually fixed.

Write it so that someone who disagrees with the decision can still reconstruct
your reasoning. If the context only makes sense once you know the answer, it is
too thin.

Length: 3-6 paragraphs. Resist listing requirements; a requirement nobody argued
about belongs in a comment, not an ADR.
-->

## Decision

<!--
What is being done, in the present tense, concretely enough to implement.

Name the files, the tables, the interfaces. "Use a circuit breaker" is not a
decision; "a `CircuitBreaker` in `lib/circuitBreaker.ts`, 5 consecutive
failures, 60s cooldown, consulted at the single choke point in
`ai.service.ts`" is.

If the decision is more than one thing, number the parts. They are separate
decisions sharing an ADR, and separating the "we rejected X because" reasoning
from each one is most of the reading value.
-->

## Why not <the obvious alternative>

<!--
Optional, but usually the section a reader actually wants.

Three attempts at the alternative, in order of how seriously you considered
them, and the specific property that made each one wrong. "We rejected it
because it is worse" is not a reason. Name the property.

This is where the reasoning that would otherwise be lost lives: the two
attempts that lost for bad reasons, and the third that lost for a good one.
-->

## Consequences

<!--
What this costs. Every real decision has accepted costs, and an ADR that lists
only benefits is marketing.

Split into two halves:

  **Accepted costs.** What is now harder, slower, or more code than it would
  have been. Also: what the reader must now not do, and what breaks if they
  do.

  **New obligations.** What someone has to maintain that they did not have to
  before. A test that must stay green, an invariant a future migration must
  preserve, a claim that has to be threaded through a new call site.

Also state anything with a known number honestly, including coverage. "89%
coverage on `hub`, 17% on `main`" is more useful than "well tested".
-->

## What we deliberately did not build

<!--
Required. This is the section that stops the next reader from re-litigating the
decision.

Each item is a thing a reasonable person would expect to be there, with the
reason it is absent. The reason must be a real one — scope, a product decision,
a deliberately accepted risk — not "we ran out of time", unless it genuinely
was time and you say so.

Name the cost of each omission as well. "No negation handling in crisis triage"
is only honest if it also says what that costs: false positives on "I don't
want to die".

ADR-0001 omits this heading and uses "What we would revisit" instead, because
it declined nothing and only has conditions for reversing. ADR-0002 and
ADR-0003 both have it. Pick whichever fits: if you declined something, you need
this section.
-->

## What we would revisit

<!--
The conditions, not the hopes.

"If it gets slow enough" is not a trigger. "A second realtime consumer appeared"
is — it names the observable that would invalidate the reasoning above, and lets
a future reader check whether it has happened without re-deriving the argument.

Usually two or three conditions, each phrased as a fact you could point at.
-->

## References

<!--
Optional. The files, PRs, tests or documents that carry the decision in code.
Worth including for anything load-bearing: it is how a reader checks that the
code still matches the record.
-->