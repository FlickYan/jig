# make_rota(staff, shifts)

Fills a week's shifts with staff. Returns `{shift id: [names]}`, or `None` when no rota keeps every
rule below. Any rota that keeps them is a right answer.

`staff` is a list of `{"name", "max_shifts", "unavailable": [shift ids], "skills": [...]}`, and
`shifts` a list of `{"id", "day" (0 is Monday), "slot" ("early", "late" or "night"), "needs", "skill"?}`.

1. Every shift gets exactly `needs` people, all different.
2. Nobody works a shift they are unavailable for.
3. Nobody works more than their `max_shifts` in the week.
4. Nobody works two shifts in a row: early then late, late then night on the same day, or a night
   then the next day's early.
5. A shift with a `skill` has at least one person with that skill on it.

The café opens at most 4 days a week and has at most 9 staff; make_rota answers such a week within a
second or two.
