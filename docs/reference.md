# Reference

## Status

Private until a legal review is done. The repository at github.com/rospocroccante/lurkd stays private until then, and the interfaces may still change. Version 0.1.0.

## What lurkd will not do

These limits hold for every version:

- It never posts, replies, likes, messages or submits any form other than a site's own search form.
- It does not work around bot detection. There is no stealth patching, no CAPTCHA solving and no proxy support. When a forum shows a login page or a human check, lurkd stops and hands the window to you.
- It never asks for, types or stores your credentials. You log in yourself, 2FA included.
- It has no bulk export, no dataset output and no search for an author across sources.
- It has no account, no telemetry and no sync. Apart from requests to the forums you read and a one-off Chromium download from Playwright's CDN on the first start, nothing leaves your machine except the text you pass to your own agent.

## Data on disk

Everything is under `~/.lurkd/`, or under the folder named by `LURKD_HOME`, with mode 0700:

- `archive.db`: the SQLite archive with threads, posts under real names, settings and the fetch log.
- `profiles/default/`: the browser profile with your cookies.
- `sources/`: sources you added.
- `run/server.json`: process id, port and token of the running server.
- `logs/server.log`: the server log.

## Retention and deletion

The page keeps archived threads for as long as you choose: everything, 30, 90 or 365 days ("Archive settings"). Each source row has "Delete archive" to remove what was read from one source. To remove everything, run `lurkd stop && rm -rf ~/.lurkd`. To remove only the browser profile and every saved login, see [Privacy and risks](privacy-and-risks.md#cookies-and-your-browser-profile).

## Limits

A read stops after 60 requests or 10 minutes, and each source has a daily request cap. Asking for a few threads at a time stays well inside both. A long thread is cut and says where to continue; pass that number as `--from-post`. Exit codes are listed in [Tools and CLI](tools-and-cli.md#exit-codes).

## Seed sources

The seed directory in `sources/` has 31 sources on cybersecurity, home automation, hardware, tools and vegetarian nutrition: 24 on Discourse, 6 on XenForo and 1 on vBulletin. Ten are marked `public_read`, meaning lurkd has read a public thread from them. The other 21 are `untested`: the rules are cited and the engine recognised from public pages, but nobody has tried them with a login.

Twelve sources forbid automated access in their own rules. Those ship switched off. To switch one on, use its switch: the page quotes the rule and asks you to press "I accept". Sources where no clear rule on automation was found are marked `unknown`. They start switched on, but every read is refused with `needs_acknowledgment` until you accept the warning. Their row shows a "Read the warning" button that opens the same dialog, with the rule line (or a note that there is none), a link to the rules and a plain statement that you take the decision. Only "I accept" lifts the refusal.

Discourse and XenForo have extractors. phpBB and vBulletin are accepted as engine names and the one vBulletin source is listed, but a read from either answers `extraction_failed` with "Engine vbulletin is not supported in this version." Sites with another engine need selectors, covered in [Adding a site](adding-a-site.md).

Sources you add yourself live in `~/.lurkd/sources/`.
