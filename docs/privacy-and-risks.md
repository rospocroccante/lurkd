# Privacy and risks

Read this page before you log in to anything you cannot afford to lose.

## What is stored, and where

Everything is under `~/.lurkd/` (or the folder named by `LURKD_HOME`), mode 0700. The archive is `archive.db`, the browser profile is `profiles/default/`, and sources you added are in `sources/`. The [reference](reference.md#data-on-disk) lists every file. lurkd contacts only the forums you read, and downloads Chromium once from Playwright's CDN on the first start. There is no account, telemetry or sync. Apart from those requests, nothing leaves your machine except the text you pass to your own agent.

On the page, "Archive settings" keeps threads for 30, 90 or 365 days or forever, and "Delete archive" on a source row removes what was read from it. To remove everything:

```sh
lurkd stop && rm -rf ~/.lurkd
```

## Pseudonyms

By default the agent sees no author names. Each author appears as `author-` followed by ten hex characters, stable per source and per installation, next to the reputation signals the forum shows: on Discourse trust level, role, title, group and posts in the topic, and on XenForo the user title, banners and any reputation figures the page shows. The salt behind the pseudonyms is created on your machine. Real names stay in the archive, and a per-source switch ("Show real names to the agent") reveals them.

Pseudonyms replace names in structural places: author lines, quote headers, profile links and the text of internal links such as "#12 by name". They do not cover names written inside a post's free text. A user who writes "thanks, Maria" gives Maria's name to your model provider, and lurkd does not try to detect it. When a Discourse forum does not serve the topic JSON, lurkd falls back to Readability on the page, and names in the page chrome are not pseudonymised there. The thread's front matter says so.

## Untrusted content

Text from the forum arrives inside `<untrusted-content>` blocks. The skill tells the agent to treat it as data and never to follow instructions found in it.

## Cookies and your browser profile

lurkd keeps your forum cookies in its own browser profile at `~/.lurkd/profiles/default`. Playwright starts that browser with a mock keychain and a basic password store, so the cookies are encrypted with a fixed key and not with your system keychain. Anyone who can read the folder can read the cookies. The only protection is the folder mode, 0700, which lets only your user account open it.

That limit is accepted in version 0.1.0 and the page says so as well. To remove the profile and every saved login:

```sh
lurkd stop && rm -rf ~/.lurkd/profiles/default
```

You will have to log in to each source again afterwards. Two alternatives are planned for later: starting a separate Chrome and attaching to it over the DevTools protocol, so that the real system keychain applies, or encrypting the profile at rest with a key held in the macOS keychain. Both need you to be present for keychain dialogs, which is why neither is in this version.

## Risks and limits

- The page sets a cookie named `lurkd_token`. Browsers do not scope cookies by port, so that cookie is sent to every service on `localhost`, whatever its port. The server checks the cookie, the `Host` header and the `Origin` header, but a local service that you run could read the token from the request it receives.
- When `lurkd start` opens your browser, the address with the token goes through the command line of `open` (macOS) or `xdg-open` (Linux). For a moment other users on the same machine can see it with `ps`. Use `--no-open` on a shared machine and open the printed address yourself.
- If a forum's own server redirects a request to another host, lurkd detects it and fails the read. The hop has already happened by then, so the browser has made one request to the redirect target.
- `--json` output of `fetch` and `search` is not wrapped as untrusted. It is for scripts. Agents should use the MCP tools or the plain CLI output, which keep the `<untrusted-content>` blocks.
- Pseudonyms do not cover names written in free text (see above).
- The cookie facts above apply: a fixed key, and a folder mode as the only protection.
- lurkd blocks every POST request except a search endpoint a source declares. That block can make Cloudflare-protected forums show more human checks. Each source has a switch, "Let Cloudflare beacons through", for a fixed list of beacon requests. It is off by default.
- Reading a forum with an automated tool may break that forum's rules, and a login-gated forum is more likely to have such rules. Sources whose rules forbid it ship off. Sources marked `unknown` have no stated rule, which does not mean permission. Using lurkd is your decision and your responsibility.
- Windows is not supported. Windsurf and OpenCode are untested. The five named hosts have not yet been tried on real installs, so a host's sandbox may stop the server from starting; in that case run `lurkd start` in a terminal first.
