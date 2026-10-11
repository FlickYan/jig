# The upload server hangs

1. Every so often the server stops responding for minutes. We traced it to some uploads with long
   names, like `scan 20240311 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011.pdf` from the
   office scanner. A name like that must be rejected at once (pdf isn't allowed anyway). Don't
   change which names are accepted: every name accepted today must still be accepted, and every
   name rejected today must still be rejected.

2. The page that lists the uploaded files' names gets slower every week, and with this month's
   100,000 uploads it takes minutes. It must show the same list, within a second or two.
