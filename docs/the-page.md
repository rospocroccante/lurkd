# The lurkd page

The page is where you decide what lurkd may read: which sources are on, which rules you accept, which drafts become sources. The agent cannot do any of that. Run `lurkd open` to open it; the link works once, within 60 seconds, so run the command again for a new tab or after a restart.

## The top of the page

The header holds the "Add a forum" button, the state of the queue and the state of lurkd's browser. Pressing the queue state shows the last 20 jobs.

Under it is the "To do" bar. Each chip names something that waits for you, with a count:

| Chip | What pressing it does |
|---|---|
| Drafts to approve | Opens the drafts, each with its YAML, domains and read endpoints, and "Approve" or "Reject". |
| Warnings to read | Shows only the sources whose rules warning you have not accepted. |
| Sessions expired | Shows only the sources whose session has expired. |
| Sites waiting for a sample | Opens the pages your agent asked to sample (see [Adding a site](adding-a-site.md#ask-the-agent)). |
| Add requests from your agent | Opens the addresses queued with `lurkd add`, each with "Analyse" and "Dismiss". |
| Forums that forbid automated access | Opens the log of rules clauses that "Analyse" found, with "Add anyway" and "Dismiss". |
| Source files with problems | Opens the source files that failed to load, with the reason. |

A chip shows only while its count is above zero; with nothing to do, the bar says "Nothing needs you". A chip that opens a panel closes it when pressed again, and a chip that filters the table clears its filter.

While a job runs, a strip under the bar names the source, what the job is doing, the requests used so far against the run's cap and how many jobs wait. lurkd runs one job at a time, so a read, a session check or an "Analyse" waits for the job before it.

## The sources table

Each source is one row: a selection box, a details button, the on/off switch, the forum name, its topics, the Session, Rules and Status columns, and a row menu. The details button opens the description, the topics, the counts of the last seven days (blocked requests, blocked beacons, human checks), when lurkd last read the source, the engine and the domains.

Above the table:

- The search box filters the rows by name, id, description, topics and domains, and searches the archived threads at the same time. Archive hits appear in their own panel; pressing one opens the thread as Markdown.
- Topic, Rules on automation (allowed, silent, forbidden) and Engine filter the rows.
- The state chips keep All, On, Off, Needs attention or Logged in.
- Sort orders the rows by name, by first topic or by last read.
- Group the rows chooses no groups, groups by topic, or your own groups (see below).

The filters, the sort and the grouping are kept in the page address after `#`, for example `#state=on&sort=last_read&group=topic`, so a reload or a bookmark opens the same view. An address with a value the page does not know opens with the default for that value.

## The row menu

The menu offers what applies to that source:

- "Log in", when the source names a login page, and "Sign up", when it names a sign-up page and has no session ([Logging in](logging-in.md)).
- "Open window", when a human check is waiting.
- "Read the warning", when the rules warning is not yet accepted.
- "Forum rules", a link to the page the rule quote comes from.
- "Show real names to the agent" and "Let Cloudflare beacons through", two switches that are off by default ([Privacy and risks](privacy-and-risks.md)).
- "Delete archive", which deletes every thread lurkd stored for the source. The forum is not touched.
- "Remove", for sources you added yourself only. It deletes the source file from `~/.lurkd/sources/` after a confirmation, and takes the source out of your groups. Its archived threads stay until you press "Delete archive". A seed source cannot be removed; switch it off instead. lurkd refuses to remove a source while a browser window is open for it.

The row "Reddit, saved threads" holds the Reddit threads you imported. It has no switch, because lurkd never reads Reddit live, and its menu offers "Import a saved Reddit thread", the Reddit User Agreement, "Show real names to the agent" and "Delete archive". See [Importing a Reddit thread](reddit-import.md).

## Groups

"Group by topic" puts each source under its first topic, so it appears once; the Topic filter still looks at every topic of a source. Sources without a topic go under "No topic".

"Group by your groups" shows the groups you made. Press "Edit groups" to create, rename or delete one. To fill a group, tick the boxes of some rows and press "Add to group"; "Remove from group" takes them out. A source can be in several groups, and sources in none are listed under "Not in a group". Deleting a group leaves its sources in lurkd with their switches as they were. Groups live in lurkd's archive, never in the source files. You can make up to 100, with names of up to 60 characters. Two names that differ only in case or spacing count as the same name, and a name cannot hold control characters or invisible ones such as zero-width spaces.

Your agent can ask for the sources of a group by its name (`sources.search` with `group`, or `lurkd sources --group <name>`), but it cannot make or change a group.

Each group header can fold its rows away, select them all, and switch them all. It shows how many of its sources are on, for example "3 of 5 on". Its switch has three states: on when every source shown is on, off when none is, and mixed in between. The header acts only on the rows the current filters show, and never on the imported Reddit threads.

## Switching sources in bulk

Tick rows (the header box selects every source shown) and press "Switch on" or "Switch off", or use a group switch. One change covers at most 500 sources.

Switching on follows the forum rules, source by source:

- A source whose rules allow automated access, or whose warning you accepted under its current rules, goes on at once.
- Sources whose rules say nothing about automation, and which you have not accepted, wait for one dialog. It lists each of them with its rule line (or a note that the rules page has nothing to quote) and a link to its rules. "I accept for these N" accepts the warning for exactly the sources listed and switches them on. Closing the dialog leaves them off.
- A source whose rules forbid automated access never goes on in bulk, not even one you accepted before. The dialog names it and says to switch it on from its own row, where its warning quotes the rule and asks for "I accept".

Switching off a group or a selection switches every source in it off, with no dialog.

## Settings

The "Settings" section at the bottom is folded by default. It holds "Keep archived threads" (everything, 30, 90 or 365 days) and the note on cookies and your browser profile.
