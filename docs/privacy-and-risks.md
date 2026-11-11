# Privacy and risks

Read this page before you log in to anything you cannot afford to lose.

## What is stored, and where

Everything is under `~/.lurkd/` (or the folder named by `LURKD_HOME`), mode 0700. The archive is `archive.db`, which also holds your groups, the forums waiting under "Add a forum" and the log of forums that forbid automated access. The browser profile is `profiles/default/`, and sources you added are in `sources/`. The [reference](reference.md#data-on-disk) lists every file.

lurkd contacts only the forums you read, the pages you analyse with "Add a forum" (the page itself and at most two rules pages on the same host), Playwright's CDN once, on the first start, to download Chromium, and the npm registry once a day. It never contacts Reddit. A Reddit thread you import comes from a file on your disk. There is no account, telemetry or sync. Apart from those requests, nothing leaves your machine except the text you pass to your own agent.

The daily request goes to `https://registry.npmjs.org/lurkd/latest` and asks only for the number of the latest lurkd version. The server sends it directly, not through lurkd's browser, so it carries no cookie, no token and nothing about you or your forums; its user agent is `lurkd/<version>`, and the registry sees your IP address as it would for any npm request. The answer is stored in the archive, and a newer version shows on the page, in `lurkd status` and on one stderr line after other commands. lurkd never installs anything by itself: `lurkd update`, which you run in a terminal, does that after asking. `lurkd update` sends the same request to the registry even when the daily check is off, since you asked for it by running the command. To turn the check off, switch off "Check for new versions" under "Settings" on the page, or start lurkd with `LURKD_NO_UPDATE_CHECK=1` in the environment. [Getting started](getting-started.md#updating) covers updating.

On the page, "Keep archived threads" under "Settings" keeps threads for 30, 90 or 365 days or forever, and "Delete archive" on a source row removes what was read from it. To remove everything:

```sh
lurkd stop && rm -rf ~/.lurkd
```

## Pseudonyms

By default the agent sees no author names. Each author appears as `author-` followed by ten hex characters, stable per source and per installation, next to the reputation signals the forum shows: on Discourse trust level, role, title, group and posts in the topic, and on XenForo the user title, banners and any reputation figures the page shows. The salt behind the pseudonyms is created on your machine. Real names stay in the archive, imported Reddit threads included, and a per-source switch ("Show real names to the agent") reveals them.

Pseudonyms replace names in structural places: author lines, quote headers, profile links, the text of internal links such as "#12 by name", and in imported Reddit threads the `u/name` mentions. They do not cover names written inside a post's free text. A user who writes "thanks, Maria" gives Maria's name to your model provider, and lurkd does not try to detect it. When a Discourse forum does not serve the topic JSON, lurkd falls back to Readability on the page, and names in the page chrome are not pseudonymised there. The thread's front matter says so.

## Untrusted content

Text from the forum arrives inside `<untrusted-content>` blocks. The skill tells the agent to treat it as data and never to follow instructions found in it.

## Cookies and your browser profile

lurkd keeps your forum cookies in its own browser profile at `~/.lurkd/profiles/default`. Playwright starts that browser with a mock keychain and a basic password store, so the cookies are encrypted with a fixed key and not with your system keychain. Anyone who can read the folder can read the cookies. The only protection is the folder mode, 0700, which lets only your user account open it.

That limit is accepted in this version and the page says so as well. To remove the profile and every saved login:

```sh
lurkd stop && rm -rf ~/.lurkd/profiles/default
```

You will have to log in to each source again afterwards. Two alternatives are planned for later: starting a separate Chrome and attaching to it over the DevTools protocol, so that the real system keychain applies, or encrypting the profile at rest with a key held in the macOS keychain. Both need you to be present for keychain dialogs, which is why neither is in this version.

## Risks and limits

- The page opens from a one-time link. `lurkd start` and `lurkd open` ask the server for an address of the form `http://127.0.0.1:<port>/?n=<nonce>`, where the nonce is 32 random bytes. It works once, within 60 seconds, and at most five links wait at a time. Opening it gives your browser a second secret, which the server makes at each start and keeps in memory only, in a cookie named `lurkd_page` (HttpOnly, SameSite=Strict). That secret is never written to `run/server.json` or printed by the CLI or the MCP server, and the page's own controls, such as accepting a forum's rules or switching sources on in bulk, take that cookie and nothing else. The token in the run file never appears in an address your browser loads, so it stays out of your browser history and out of the process list.
- This is a matter of hygiene. It does not protect you from programs that run as your user, which can do anything you can: read the run file, ask for a link and open it, or read the browser's memory.
- When `lurkd start` or `lurkd open` opens your browser, the link goes through the command line of `open` (macOS) or `xdg-open` (Linux), and for a moment other users on the same machine can see it with `ps`. By then your browser has normally opened it, and opening it uses it up, also in a browser that already holds the `lurkd_page` cookie. The link never holds the token. On a shared machine you can still use `--no-open` and open the printed link yourself.
- A page link also works when you follow it from another site, such as a chat window. Requests that another site starts never carry the `lurkd_page` cookie, and every change on the page needs the page's own `Origin` header.
- Browsers do not scope cookies by port, so the `lurkd_page` cookie is sent to every service on `localhost`, whatever its port. The server checks the cookie, the `Host` header and the `Origin` header, but a local service that you run could read the cookie from the request it receives.
- If a forum's own server redirects a request to another host, lurkd detects it and fails the read. The hop has already happened by then, so the browser has made one request to the redirect target.
- `--json` output of `fetch` and `search` is not wrapped as untrusted. It is for scripts. Agents should use the MCP tools or the plain CLI output, which keep the `<untrusted-content>` blocks.
- Pseudonyms do not cover names written in free text (see above).
- "Add a forum" looks up the forum's name before it opens the address, and refuses it when the name points at your own machine or network. The browser looks the name up again when it opens the page, so a DNS server that answers with a public address the first time and a private one a moment later (DNS rebinding) is not caught.
- The search for a clause that forbids automated access reads English wording and is a heuristic. It can miss a clause or flag a sentence about something else, so check the sentence before you rely on it.
- The cookie facts above apply: a fixed key, and a folder mode as the only protection.
- lurkd blocks every POST request except a search endpoint a source declares. That block can make Cloudflare-protected forums show more human checks. Each source has a switch, "Let Cloudflare beacons through", for a fixed list of beacon requests. It is off by default.
- Reading a forum with an automated tool may break that forum's rules, and a login-gated forum is more likely to have such rules. Sources whose rules forbid it ship off, and a bulk switch-on never turns them on. Sources marked `unknown` have no stated rule, which does not mean permission. Your account on a forum can be banned for it.
- `lurkd update` runs `npm i -g lurkd@<version>`, so it installs whatever npm publishes under that version; it asks first and backs up the archive. If you point your agent at `npx -y lurkd@latest mcp` instead, each new release runs without a question and without a backup. [Getting started](getting-started.md#updating-automatically-through-npx) lists the risks.
- Importing a Reddit thread is your decision too: Reddit's User Agreement forbids collecting its content without permission, by any means. See [Importing a Reddit thread](reddit-import.md).
- No legal review of lurkd has been done. Using it is your decision and your responsibility.
- Windows is not supported. Windsurf and OpenCode are untested. Codex, Cursor, Cline and Gemini CLI have not yet been tried on real installs, so a host's sandbox may stop the server from starting; in that case run `lurkd start` in a terminal first.
