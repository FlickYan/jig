# standings(results) -> list of rows

The league table for a list of lines, each a match result like `Ajax 3-1 Benfica` (the home team, each
side's goals, and the away team), a walkover, or a points deduction.

1. A team's name is one or more words of letters (`A-Z`, `a-z`) with single spaces between them. Lines
   use single spaces as shown, and spaces before or after a whole line don't matter. A line is one of:
   - a result, `<team> <goals>-<goals> <team>`, with goals as whole numbers written in digits;
   - a walkover, `<team> w/o <team>`: the first team is awarded the match 3-0, and it counts as that
     result everywhere, head to head included;
   - a deduction, `<team> -<points>`, with a positive whole number: those points come off the team's
     total. A deduction isn't a match, and counts nowhere else: not head to head (rule 4a), and not in
     goals.
   A team can't play itself. Any other line raises `ValueError`.
2. A win is worth 3 points, a draw 1 and a loss 0. Every team that a line names is in the table, even
   one that only had a deduction.
3. Teams are ranked by points (after deductions).
4. Teams level on points are ranked by these criteria, in order:
   a. Head to head: the points they took in the matches among themselves alone (all of those matches,
      if they met more than once), then their goal difference in those matches, then the goals they
      scored in them.
   b. If the head-to-head criteria rank some of the teams but leave others still level, the head-to-head
      criteria are applied again to each group of teams still level, using only the matches among the
      teams of that group, and so on for as long as they separate teams.
   c. A group of teams that the head-to-head criteria can't separate at all (each has the same
      head-to-head points, goal difference and goals) is ranked by goal difference over all their
      matches, then goals scored over all their matches.
5. Teams level on everything in rules 3 and 4 share a position, and are listed by name, in Python's
   string order. The next team's position counts every team above it: positions run 1, 2, 2, 4.
6. Each row is a tuple `(position, team, played, won, drawn, lost, goals_for, goals_against,
   goal_difference, points)` (or a namedtuple with those fields), from the top of the table down.
