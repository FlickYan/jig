# Problems the librarians reported

1. **Returning a book on its due date costs a fine.** Maria returned *Dune* on the day it was due, and
   was charged $0.25. A book is late only after its due date.

2. **Fines for very late books are too small.** A book returned 40 days late was fined $1.25. Fines are
   $0.25 a day, up to $5.00 for a loan, so that should have been $5.00.

3. **Renewing early loses days.** A member who renewed a book three days after borrowing it got a due
   date 14 days after the renewal, 11 days sooner than it should be: a renewal adds 14 days to the
   loan's due date.

4. **Suspended members can still borrow.** A member whose status is `suspended` checked out a book.
   Suspended members mustn't check out books, though they may still return and renew the ones they
   have.

5. **Past loans count against the limit.** Ana borrowed three books in March and returned them all,
   and in April she couldn't check out a book: she was told she already had three. Only books a member
   still has count toward the three.

6. **Books fall due on Sundays.** We're closed on Sundays, so a member can't return a book due then,
   and is fined for the Monday. A due date that would fall on a Sunday should be the Monday after.
