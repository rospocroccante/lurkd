# Reference

## Status

Version 0.2.0. The repository at github.com/rospocroccante/lurkd is public under the Apache-2.0 licence, and the package is published on npm as `lurkd`. The interfaces may still change between minor versions; [CHANGELOG.md](https://github.com/rospocroccante/lurkd/blob/main/CHANGELOG.md) lists what changed.

No legal review of lurkd has been done. Reading a forum with an automated tool may break that forum's rules, and using lurkd is your decision and your responsibility.

## What lurkd will not do

These limits hold for every version:

- It never posts, replies, likes, messages or submits any form other than a site's own search form.
- It does not work around bot detection. There is no stealth patching, no CAPTCHA solving and no proxy support. When a forum shows a login page or a human check, lurkd stops and hands the window to you.
- It never asks for, types or stores your credentials. You log in yourself, 2FA included.
- It never creates an account. "Sign up" opens a forum's registration page and you register by hand.
- Its headless reading browser never contacts Reddit. You can import a thread you saved yourself.
- It never opens a new host because an agent asked. An agent can queue one with `lurkd add`, and lurkd opens it when you press "Analyse". Reads on approved sources use the addresses agents give, inside that source's domains.
- It has no bulk export, no dataset output and no search for an author across sources.
- It has no account, no telemetry and no sync. Apart from requests to the forums you read or analyse and a one-off Chromium download from Playwright's CDN on the first start, nothing leaves your machine except the text you pass to your own agent.

## Data on disk

Everything is under `~/.lurkd/`, or under the folder named by `LURKD_HOME`, with mode 0700:

- `archive.db`: the SQLite archive with threads (imported Reddit threads included), posts under real names, sessions, settings, the fetch log, drafts, the forums queued for "Add a forum", the log of forums that forbid automated access, and your groups.
- `profiles/default/`: the browser profile with your cookies.
- `sources/`: sources you added.
- `run/server.json`: process id, port and token of the running server. The CLI and the MCP server use the token; it never goes into an address your browser opens, because the page opens from a one-time link (`lurkd open`). The page's own secret lives in the server's memory only.
- `logs/server.log`: the server log.

The archive is at schema version 6 in lurkd 0.2.0 (0.1.0 wrote version 1). lurkd upgrades an older archive in place on its first start, in one transaction, and keeps everything in it. An older lurkd refuses to open a newer archive and does not start; its log says "archive schema version 6 is newer than this lurkd supports (1)". If you might go back to 0.1.0, run `lurkd stop` and copy `~/.lurkd/archive.db` before you upgrade, and put that copy back when you downgrade.

## Retention and deletion

The page keeps archived threads for as long as you choose: everything, 30, 90 or 365 days ("Keep archived threads" under "Settings"). Each source row has "Delete archive" to remove what was read from one source. "Remove" deletes a source you added, but not its archived threads. To remove everything, run `lurkd stop && rm -rf ~/.lurkd`. To remove only the browser profile and every saved login, see [Privacy and risks](privacy-and-risks.md#cookies-and-your-browser-profile).

## Limits

A read stops after 60 requests or 10 minutes, and each source has a daily request cap. Asking for a few threads at a time stays well inside both. A long thread is cut and says where to continue; pass that number as `--from-post`. Exit codes and error codes are listed in [Tools and CLI](tools-and-cli.md#exit-codes).

Other limits in this version:

| What | Limit |
|---|---|
| Rules pages "Analyse" reads after the page you gave | 2 on Discourse and XenForo, 1 on other engines, same host only |
| Forums waiting under "Add a forum" | 20 |
| Saved Reddit thread file | 20 MB, one file per import |
| Comments kept from one imported thread | 20,000 (the post is always kept) |
| Imported title and body | 300 and 100,000 characters |
| Groups | 100, names of up to 60 characters |
| Sources in one bulk change | 500 |
| One-time page link | 60 seconds, used once, at most 5 waiting |
| Login or sign-up window | closes by itself after 15 minutes |

## Seed sources

The seed directory in `sources/` has 31 sources on cybersecurity, home automation, hardware, tools and vegetarian nutrition: 24 on Discourse, 6 on XenForo and 1 on vBulletin. Ten are marked `public_read`, meaning lurkd has read a public thread from them. The other 21 are `untested`: the rules are cited and the engine recognised from public pages, but nobody has tried them with a login. None of them lists a sign-up page yet.

Twelve sources forbid automated access in their own rules. Those ship switched off. To switch one on, use its switch: the page quotes the rule and asks you to press "I accept". A bulk switch-on never turns them on. Sources where no clear rule on automation was found are marked `unknown`. They start switched on, but every read is refused with `needs_acknowledgment` until you accept the warning. Their row menu has "Read the warning", which opens the same dialog, with the rule line (or a note that there is none), a link to the rules and a plain statement that you take the decision. Only "I accept" lifts the refusal.

One more source is built into lurkd: `reddit-import`, "Reddit, saved threads", which holds the Reddit threads you imported. It is never read live and cannot be switched on or removed.

Discourse and XenForo have extractors. phpBB and vBulletin are accepted as engine names and the one vBulletin source is listed, but a read from either answers `extraction_failed` with "Engine vbulletin is not supported in this version." Sites with another engine need selectors, covered in [Adding a site](adding-a-site.md).

Sources you add yourself live in `~/.lurkd/sources/`.

## Known limits

- Names written inside a post's text are not pseudonymised, on any forum and in imported Reddit threads, and reach your model provider as written.
- The search for a clause that forbids automated access reads English wording only and is a heuristic. It can miss a clause or flag the wrong sentence; you can change the policy and the quote in the form before you save the draft.
- "Add a forum" refuses a name that resolves to your own machine or network, but the browser resolves the name again when it opens the page, so DNS rebinding between the two lookups is not caught.
- The "read without login: the session expired" note is part of the answer to the read only, not of the archived copy.
- The browser profile's cookies use a fixed key; the folder's 0700 mode is their only protection.
- Windows is not supported.
- Of the targeted hosts, only Claude Code has been tried on a real install.
