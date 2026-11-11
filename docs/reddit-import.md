# Importing a Reddit thread

lurkd does not read Reddit. Its headless reading browser refuses every request to reddit.com, redd.it, Reddit's media and static hosts and redditinc.com, including an image that a forum post embeds, and no source file may list a Reddit domain. The login, sign-up and sample windows are different: they are ordinary browser windows that you use yourself, so a forum page you open there can load Reddit content, such as an embedded image. `source.fetch`, `source.sample`, `lurkd add` and "Analyse" answer a Reddit address with `unsupported` and the steps below.

There are two reasons. In a test on 2026-11-10, Reddit served its "blocked by network security" page and HTTP 403 to lurkd's headless browser, even with a logged-in session, and lurkd does not work around blocks. And section 7 of Reddit's User Agreement ("Things You Cannot Do", effective 1 July 2026) forbids it:

> Access, search, or collect data from the Services by any means (automated or otherwise) except as permitted in these Terms or in a separate agreement with Reddit (we conditionally grant permission to crawl the Services in accordance with the parameters set forth in our robots.txt file, but scraping the Services without Reddit’s prior written consent is prohibited); or

What lurkd can do is turn a thread that you saved yourself, from your own browser, into Markdown in your local archive.

## Your responsibility

The clause says "by any means (automated or otherwise)", so it does not stop at automated tools. The import is meant for your own use: one thread at a time, kept on your machine, read by you as a person. lurkd has no bulk import and takes no folders. No legal review has been done, and whether to save and import a thread, and the responsibility for it, are yours.

## Saving and importing a thread

1. Open the thread in your own browser.
2. Add `.json` to the end of its address, for example `https://www.reddit.com/r/sub/comments/abc123/title.json`, and open that address.
3. Save the page that opens as a file.
4. Import the file, either from the command line:

   ```sh
   lurkd import reddit ~/Downloads/title.json
   ```

   or on [the lurkd page](the-page.md): open "Add a forum" and use "Import a saved Reddit thread" (the row menu of "Reddit, saved threads" has the same entry).

The CLI reads the file itself and sends its content to the lurkd server, which never receives a path. The file must be one regular file of at most 20 MB, holding one Reddit thread in Reddit's JSON format; anything else is refused with `invalid_request` and a message that says what is wrong, and nothing is stored. Importing the same thread again replaces the earlier import, and the answer gives the date of the one it replaced.

## What the thread looks like

The thread is stored under the built-in source `reddit-import` ("Reddit, saved threads"), which is never read live. The post is `#1` and the comments follow depth-first, in the order the file holds them, numbered on. Each comment says which post it answers ("in reply to #7"), with its score, an OP marker, the author's flair, and moderator or edited marks where Reddit gives them. Removed and deleted comments stay as Reddit wrote them, `[removed]` or `[deleted]`, so the chain of replies holds. The front matter holds the title, an `extraction` line with the subreddit and how many comments the file held, `imported: "from a saved file; lurkd did not contact the site"` and the route the file came through (`page upload` or `lurkd import / API`). Post #1 names the subreddit too.

A saved file does not hold every comment of a large thread. Where Reddit left comments out, the thread says so, for example "12 more comments are not in the saved file". lurkd keeps at most 20,000 comments of one thread; when a file holds more, post #1 says how many were not kept. A title is cut at 300 characters and a body at 100,000, with a note where it was cut.

Authors become pseudonyms, as on every forum, and so do the `u/name`, `/u/name`, `/user/name` and `r/u_name` mentions in titles and bodies. Subreddit names stay. Names written in plain text are not pseudonymised. The archive keeps the real usernames, and the source's "Show real names to the agent" switch works as for any other source.

## How the agent finds it

`archive.search` finds imported threads like any other. `source.fetch` with the thread's Reddit address returns the imported copy from the archive; with `refresh`, or for a thread that was never imported, it answers `unsupported` with the import steps.
