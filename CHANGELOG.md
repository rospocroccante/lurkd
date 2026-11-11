# Changelog

All notable changes to lurkd, newest first.

## 0.2.1 (2026-11-11)

### Added

- A daily update check. The server asks `https://registry.npmjs.org/lurkd/latest` at most once every 24 hours, with a direct request that carries no cookie or token and the user agent `lurkd/<version>`, and keeps the answer in the archive. A newer stable version shows as a banner on the page (dismissed per version; the archive keeps the dismissal across restarts), as an "Update:" line and an `update` field in `lurkd status`, and as one stderr line after other CLI commands. It never shows in `--json` output or in MCP tool answers. Turn it off with "Check for new versions" under "Settings" or with `LURKD_NO_UPDATE_CHECK=1`.
- `lurkd update [--yes]`. It asks first, stops the server, writes a consistent copy of the archive to `~/.lurkd/backups/archive-<version>-<UTC time>.db` through SQLite, runs `npm i -g lurkd@<latest>`, checks the result with `lurkd --version` and prints how to go back, with the paths quoted for the shell and the archive's `-wal` and `-shm` files removed before the copy goes back. It changes nothing on a clone (an `npm link` included), an npx run or a global folder your user cannot write to, and prints the command to run instead. It asks the registry even when the daily check is off, since you run it on purpose. No server route and no MCP tool runs npm.
- `GET /api/update`, which the CLI reads for its stderr line, and `POST /api/update/dismiss`, which only the page can call.

### Changed

- A command or the MCP server that reaches a server of another lurkd version says so once. When the server is older, the advice is `lurkd stop`, then `lurkd start`. When the server is newer, which is the usual case after an update, the advice is to restart the agent session (for `lurkd mcp`) or to run the new `lurkd`. A route the server lacks answers with that line instead of "No such route", and the CLI prints the line once. The MCP server puts it before its first tool answer. At the end, `lurkd update` asks you to restart your agent sessions.
- Addresses in the error messages agents see are printed as quoted data: the rules page of a source, an address a forum chose, and addresses cut to their origin and path. Characters that could end the quotes or the line are percent-encoded.
- The archive stays at schema version 6: the update check keeps its data in the existing settings table. lurkd 0.2.0 opens an archive that 0.2.1 has used, so going back from 0.2.1 to 0.2.0 needs no backup. Going back to 0.1.0 still does, and `lurkd update` makes one before every install.
- The guide covers updating, the backup folder and the `npx -y lurkd@latest mcp` route with its risks, and lists the npm registry among the hosts lurkd contacts.

### Fixed

- A draft an agent submits with `source.sample` and `draft_yaml` now follows the address rules of "Add a forum" for `base_url`, `domains`, `login_url`, `signup_url`, `search_url`, `session_check.url` and `automation.rule_url`: https only, no host on your own machine or network, no user name or password, no Reddit. Before the draft is stored, lurkd looks up the host of `base_url` and every domain, and refuses a name that resolves to a private address or does not resolve. The page's own "Add a forum" drafts follow the same checks.
- "Approve" runs the same address rules and lookups again before it writes the source, so a draft saved by an earlier version is refused if its addresses break them.
- An address with a quote mark in it is printed in error messages as one quoted value, with the quote mark percent-encoded, never as two quoted values side by side.

## 0.2.0 (2026-11-11)

### Added

- "Add a forum" on the lurkd page. Give it the address of a forum page and press "Analyse": lurkd opens that one page read-only, recognises Discourse and XenForo, fills in the name, base address, domain, login, sign-up and search pages, and lists the rules links it found. The form saves a draft that goes through "Drafts to approve" like any other.
- Rules pages: "Analyse" reads at most two rules pages on the same host (Discourse `/tos` and `/guidelines`, XenForo `/help/terms/`, otherwise the first rules link) and looks for a sentence that forbids automated access. A sentence found prefills the policy as Forbidden with the quote.
- "Forums that forbid automated access": a log of every such sentence, with "Add anyway" (a draft that stays off until you approve it, switch it on and press "I accept") and "Dismiss".
- `lurkd add <url>`, which queues an address for "Add a forum". lurkd opens it only when you press "Analyse".
- "Remove" in the row menu of a source you added. It deletes the source file; its archived threads stay until "Delete archive".
- "Sign up": a source with the new optional `signup_url` field offers its registration page in the lurkd window. You register by hand; lurkd never creates accounts.
- Reddit import: `lurkd import reddit <file>`, and "Import a saved Reddit thread" on the page, turn one thread you saved from your own browser (its address with `.json` added) into Markdown in the archive, under the built-in source `reddit-import`. At most 20 MB per file and 20,000 comments per thread; comments the file does not hold are noted.
- Groups on the page: group the table by first topic or by groups you make, fold groups, and switch a whole group with a three-state switch. Row boxes select sources for bulk switching and for adding to or removing from a group.
- `group` on `sources.search` and `--group` on `lurkd sources`, to list the sources of one of your groups by name. Agents cannot make or change groups.
- `lurkd open`, which opens the lurkd page with a new one-time link and starts the server if needed.
- The error code `unsupported` (exit code 1), for things lurkd does not do at all. Today that is reading, sampling, queueing or analysing Reddit; the message gives the import steps.
- `repository`, `homepage`, `bugs` and `keywords` in `package.json`, and this changelog.
- New guide pages: "The lurkd page" and "Importing a Reddit thread".

### Changed

- A login is optional. An expired session no longer stops a read: lurkd reads the forum without login, the thread's front matter says `read without login: the session expired`, the agent is told the same, and the row keeps "Session expired". A login wall during that read still stops it with `needs_login`. `session.status` now says that public threads still come back for an expired session.
- The lurkd page has a new layout: a header with "Add a forum", the queue and the browser state; a "To do" bar with counts that open their panel or filter the table; a progress strip for the running job; and one table row per source with a row menu. The table has search, filters for topic, state, rules and engine, sorting by name, topic or last read, and keeps the view in the address after `#`. Settings and the cookie note are folded at the bottom.
- Switching sources on in bulk follows the forum rules: sources whose rules allow automated access, or whose warning you accepted, go on at once; sources whose rules say nothing wait for one dialog that lists each with its rule line; sources whose rules forbid automated access never go on in bulk.
- `lurkd start` opens the page every time, also when the server was already running.
- `lurkd status` prints the page address without the token and names `lurkd open`; `--json` has an `open` field.
- The archive moves from schema version 1 to 6. lurkd upgrades it in place on the first start. lurkd 0.1.0 refuses to open an upgraded archive, so back up `~/.lurkd/archive.db` first if you might go back.
- The documentation describes the public repository and the npm package, and installs with `npm i -g lurkd` first.

### Fixed

- A post with a very long body, such as millions of short lines or one name mentioned many times, no longer stalls the server while it renders: the Markdown guard runs in one pass and each pseudonym is computed once per name.
- The archive remembers every post author of a thread and the first 5,000 names its bodies mention, so a crafted thread can no longer fill the authors table.
- Dates after the year 9999 no longer break the post header.

### Security

- The page no longer holds the server's token. `lurkd start` and `lurkd open` open a one-time link (32 random bytes, valid 60 seconds, used once) that holds no token, and opening it gives the browser a separate page secret in an `HttpOnly`, `SameSite=Strict` cookie, `lurkd_page`. The page's own routes take only that cookie; the old `lurkd_token` cookie is refused and cleared. The token stays out of the browser history and out of the command line of `open`. This is hygiene: programs that run as your user can still do anything you can.
- `lurkd status` no longer prints the token.
- The guard of lurkd's headless reading browser refuses every request to Reddit's hosts, and no source file may list them. The login, sign-up and sample windows are ordinary browser windows that you use yourself, so a page you open there can load Reddit content.
- "Add a forum" and `lurkd add` refuse addresses on your own machine or network, addresses with a user name or password, and plain `http`. Before "Analyse" opens a name, lurkd looks it up and refuses it when any address is private. DNS rebinding between that lookup and the browser's own remains possible.
- The import route takes the content of a saved thread, never a path, so an agent cannot use it to read files through lurkd.
- Group names refuse control characters and invisible characters such as zero-width spaces.
- A source name comes from the forum's own page (`og:site_name` or the title), so a forum could word it as an instruction. Wherever lurkd shows a source name or description to an agent (`sources.search`, `session.status`, `lurkd status` and every error message), it now prints it in double quotes, keeps only letters, digits, spaces and a few punctuation marks, and cuts it at 60 characters (160 for a description). The skill tells agents that quoted text is data. "Add a forum" and "Add anyway" show the detected name in a field you can correct before you save the draft.
- `source.sample` applies the address rules of "Analyse" before it puts a page in "Sites waiting for a sample": no address on your own machine or network, `https` only, and a name that resolves only to public addresses. The sample window opens outside the read-only guard, so a local address could otherwise reach it.

### Known issues

- The CLI does not notice a server from an older version that is still running. Run `lurkd stop` before you upgrade.
- Chromium can use its own secure DNS and resolve a name differently from the lookup lurkd runs before "Analyse" and `source.sample`.
- "Remove" deletes the source file but leaves the forum's cookies in the browser profile.

## 0.1.0 (2026-11-10)

First release.

- Six MCP tools with matching CLI commands: `sources.search`, `source.fetch`, `archive.search`, `session.status`, `source.sample` and `author.signals`, over `lurkd mcp` on stdio, with `--tool-names=underscore` for hosts that refuse dots.
- Extractors for Discourse and XenForo; selector-based sources for other engines, drafted by the agent with `source.sample` and approved by the user on the page.
- A headless Chromium through Playwright, behind a read-only guard that blocks every POST except a search endpoint a source declares, with no stealth patching, CAPTCHA solving or proxies. Login walls and human checks stop the read and hand the window to the user.
- Threads as Markdown with post order, quotes and page numbers, authors replaced by stable pseudonyms, forum text wrapped in `<untrusted-content>` blocks, and a local SQLite archive with full-text search and a retention setting.
- Request limits: 60 requests or 10 minutes per run and a daily cap per source.
- 31 seed sources, each with a cited rule on automated access; the twelve whose rules forbid it ship switched off, and the ones with no clear rule need an acknowledgement before the first read.
- The lurkd page on 127.0.0.1 for logging in, accepting rules warnings, approving drafts and managing the archive.
- A skill for agents, and manifests for Claude Code, Gemini CLI and Cursor.
