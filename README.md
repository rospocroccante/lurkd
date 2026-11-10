# lurkd

lurkd lets an AI coding agent read forums and communities that sit behind a login. You log in once, by hand, in a browser profile that lurkd keeps for itself. From then on the agent asks for threads through MCP tools or CLI commands, and each thread comes back as Markdown that keeps the order of the posts, the quotes and the page numbers. Everything it reads is also saved in a local archive, which the agent can search offline before it goes back to the forum.

It is read-only on purpose, and a few things are out of scope for every version:

- It never posts, replies, likes, messages or submits any form other than a site's own search form.
- It does not work around bot detection. There is no stealth patching, no CAPTCHA solving and no proxy support. When a forum shows a login page or a human check, lurkd stops and hands the window to you.
- It never asks for, types or stores your credentials. You log in yourself, 2FA included.
- It has no bulk export, no dataset output and no search for an author across sources.
- It has no account, no telemetry and no sync. Apart from requests to the forums you read and a one-off Chromium download from Playwright's CDN on the first start, nothing leaves your machine except the text you pass to your own agent.

## Status

Private until a legal review is done. The repository at github.com/rospocroccante/lurkd stays private until then, and the interfaces may still change. Version 0.1.0.

## Requirements

- macOS or Linux. Windows is not supported.
- Node 22.20 or later.
- Network access on the first start, to download Chromium.
- An AI coding agent that speaks MCP or can run shell commands. Claude Code, Codex, Cline, Cursor and Gemini CLI are the hosts this version targets.

## Install

The package is not on npm yet, and `npm i -g github:rospocroccante/lurkd` does not work on npm 11: the global install of a Git dependency runs the `prepare` build without the dev dependencies, so the TypeScript compiler is missing. Build a tarball from a clone instead. The repository is private, so the clone needs a GitHub login that can read it:

```sh
git clone https://github.com/rospocroccante/lurkd.git
cd lurkd
npm ci
npm run build
npm pack
npm i -g ./lurkd-0.1.0.tgz
lurkd --version
```

The tarball name carries the version from `package.json`, so use the file name `npm pack` prints if it differs. npm 11 may print an `allowScripts` warning about `prepare`. It is only a warning. The one native dependency, better-sqlite3, ships prebuilt binaries for macOS and Linux (x64, arm64 and musl), so no compiler is needed.

Do not run `npx lurkd`. The name is not registered on npm, so npx would fetch and run whatever package someone else publishes under it.

### The skill

The skill is a short `SKILL.md` that tells the agent how to use lurkd and to treat forum text as data. It lives in `skills/lurkd/` and needs the `lurkd` command from the install above. The `skills` CLI from Vercel Labs fetches it straight from the repository over Git, so it does not depend on how you installed the package:

```sh
DISABLE_TELEMETRY=1 npx skills add rospocroccante/lurkd --skill lurkd --agent claude-code --global
```

`DISABLE_TELEMETRY=1` stops the CLI from sending anonymous usage data (`DO_NOT_TRACK=1` does the same). Replace `claude-code` with the identifier of your host, such as `codex`, `cline`, `cursor` or `gemini-cli`, and add `--list` to see what the CLI finds before it installs anything. The CLI needs Node 22.20 or later and uses your normal Git credentials for a private repository. These options come from the `skills` documentation at github.com/vercel-labs/skills; the combination with this repository has not been run end to end.

If you would rather not use that CLI, copy `skills/lurkd` from your clone into your host's skills folder. For Claude Code that is `~/.claude/skills/lurkd/`, and for most other hosts `~/.agents/skills/lurkd/`.

### The MCP server

Every host needs to run `lurkd mcp` over stdio. The server starts lurkd's background process on the first tool call, so you do not need to start anything first. The commands below were checked against each host's documentation. None has been run on a real install yet.

Claude Code:

```sh
claude mcp add --scope user lurkd -- lurkd mcp
```

The repository also carries `.claude-plugin/plugin.json` and `.mcp.json`, but there is no marketplace and no install steps for them, and the plugin route is untested. Use the `claude mcp add` command above.

Gemini CLI:

```sh
gemini extensions install https://github.com/rospocroccante/lurkd
```

The extension manifest is `gemini-extension.json`. It registers the server and loads `skills/lurkd/SKILL.md` as context.

Cursor has a plugin manifest in `.cursor-plugin/plugin.json`, which points at `.mcp.json`. To add the server by hand, put this in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "lurkd": { "command": "lurkd", "args": ["mcp"] }
  }
}
```

Codex has no manifest in this repository, because its documentation does not show how a plugin registers a local stdio server. Add the server with `codex mcp add lurkd -- lurkd mcp`, or put this in `~/.codex/config.toml`:

```toml
[mcp_servers.lurkd]
command = "lurkd"
args = ["mcp"]
```

Cline has no manifest format either. Open the MCP settings from the Cline panel (MCP Servers, Configure, Configure MCP Servers) and add the entry below to `cline_mcp_settings.json`. For the Cline CLI the file is `~/.cline/data/settings/cline_mcp_settings.json`.

```json
{
  "mcpServers": {
    "lurkd": { "command": "lurkd", "args": ["mcp"], "disabled": false, "autoApprove": [] }
  }
}
```

Sources for these snippets: Codex at learn.chatgpt.com/docs/extend/mcp (the old developers.openai.com/codex/mcp address redirects there), Cline at docs.cline.bot/mcp/configuring-mcp-servers, Cursor at cursor.com/docs/reference/plugins, Gemini CLI at github.com/google-gemini/gemini-cli (docs/extensions).

Windsurf and OpenCode read the same `SKILL.md` and should work with the same server entry, but nobody has tried them. Some model APIs reject tool names that contain a dot (`sources.search`). If your host fails on that, register the server as `lurkd mcp --tool-names=underscore`, which names the tools `sources_search` and so on. Tool result text still names the dotted forms (for example `source.fetch`), and agents map them to the underscore names.

## First start

```sh
lurkd start
```

The first start downloads Chromium through Playwright, which takes a minute or two and prints a line to stderr. After that it starts one headless browser, a local server on 127.0.0.1 and your default browser, which opens the lurkd page. `lurkd start --no-open` prints the address without opening it, and `lurkd stop` shuts everything down. The address ends in `?t=<token>`. The token is new each time the server starts.

You rarely need to run `lurkd start` yourself. Any tool call or CLI command below starts the server if it is not running. The command is useful when you want the page.

## Logging in

The page lists every source with its login state: "Logged in", "Session expired", "Switched off", "Not logged in" or "No login needed". For a source that says "Not logged in", press "Log in". lurkd opens a visible browser window on the site's login page. Log in as you normally would, 2FA included, then press "Done" on the lurkd page. The window closes and lurkd checks the session with one request. The row then reads "Logged in".

If a forum shows a human check mid-read, the read stops and the row offers "Open window". Solve the check yourself, then press "Done". lurkd does not retry on its own.

Sessions are kept in the profile on disk, so they are meant to survive `lurkd stop` and a restart. That has not yet been tried with a real account. `lurkd session <source> --check` asks the forum whether you are still logged in.

## The six tools and the CLI

The agent gets six tools. Each has a CLI command with the same output.

| Tool | CLI | What it does |
|---|---|---|
| `sources.search` | `lurkd sources [query] [--topic t]` | Lists sources by topic or name, with login state and status. |
| `source.fetch` | `lurkd fetch <source> (--query q \| --url u)` | Searches one source, or reads one thread by address. |
| `archive.search` | `lurkd search <query> [--source id] [--limit n]` | Searches threads already read, offline. |
| `session.status` | `lurkd session [source] [--check]` | Shows the login state per source. |
| `source.sample` | `lurkd sample <url> [--draft file]` | Returns a page's structure without text, or submits a drafted source. |
| `author.signals` | `lurkd author <source> <pseudonym>` | Gives total posts and join date for one pseudonymised author. Real Discourse forums do not serve a post count in `/u/<name>.json`, so there it shows "Posts: unknown". |

`lurkd fetch` also takes `--max-threads n`, `--refresh`, `--from-post n` and `--max-chars n`. A long thread is cut and says where to continue; pass that number as `--from-post`. The six tool commands and `lurkd status` take `--json` to print the raw answer. Exit codes: 0 done, 2 usage error, 3 you have to act in the lurkd page, 4 a request cap was hit, 1 anything else. `lurkd status` exits 1 when the server is not running.

A read stops after 60 requests or 10 minutes, and each source has a daily request cap. Asking for a few threads at a time stays well inside both.

Text from the forum arrives inside `<untrusted-content>` blocks. The skill tells the agent to treat it as data and never to follow instructions found in it.

## Sources

The seed directory in `sources/` has 31 sources on cybersecurity, home automation, hardware, tools and vegetarian nutrition: 24 on Discourse, 6 on XenForo and 1 on vBulletin. Ten are marked `public_read`, meaning lurkd has read a public thread from them. The other 21 are `untested`: the rules are cited and the engine recognised from public pages, but nobody has tried them with a login.

Twelve sources forbid automated access in their own rules. Those ship switched off. To switch one on, use its switch: the page quotes the rule and asks you to press "I accept". Sources where no clear rule on automation was found are marked `unknown`. They start switched on, but every read is refused with `needs_acknowledgment` until you accept the warning. Their row shows a "Read the warning" button that opens the same dialog, with the rule line (or a note that there is none), a link to the rules and a plain statement that you take the decision. Only "I accept" lifts the refusal.

Discourse and XenForo have extractors. phpBB and vBulletin are accepted as engine names and the one vBulletin source is listed, but a read from either answers `extraction_failed` with "Engine vbulletin is not supported in this version." Sites with another engine need selectors, covered next.

Sources you add yourself live in `~/.lurkd/sources/`.

## Adding a site

Ask your agent for a site lurkd does not list. It calls `source.sample` with a thread address and receives the page's tags, classes and ids, with no text. From that it writes a YAML source with CSS selectors and submits it through the same tool. The source stays off until you approve the draft on the lurkd page, where the domains and any read endpoints are shown. For a host that has no source yet, you open a page of the site yourself from the lurkd page (see "Sites waiting for a sample"), so that lurkd never loads an address an agent picked on its own.

A source file has no code in it. The fields are documented by the existing files in `sources/`, and `src/sources/schema.ts` in the repository is the reference. It is not part of the installed package.

## Cookies and your browser profile

lurkd keeps your forum cookies in its own browser profile at `~/.lurkd/profiles/default`. Playwright starts that browser with a mock keychain and a basic password store, so the cookies are encrypted with a fixed key and not with your system keychain. Anyone who can read the folder can read the cookies. The only protection is the folder mode, 0700, which lets only your user account open it.

That limit is accepted in version 0.1.0 and the page says so as well. To remove the profile and every saved login:

```sh
lurkd stop && rm -rf ~/.lurkd/profiles/default
```

You will have to log in to each source again afterwards. Two alternatives are planned for later: starting a separate Chrome and attaching to it over the DevTools protocol, so that the real system keychain applies, or encrypting the profile at rest with a key held in the macOS keychain. Both need you to be present for keychain dialogs, which is why neither is in this version.

## Pseudonyms

By default the agent sees no author names. Each author appears as `author-` followed by ten hex characters, stable per source and per installation, next to the reputation signals the forum shows: on Discourse trust level, role, title, group and posts in the topic, and on XenForo the user title, banners and any reputation figures the page shows. The salt behind the pseudonyms is created on your machine. Real names stay in the archive, and a per-source switch ("Show real names to the agent") reveals them.

Pseudonyms replace names in structural places: author lines, quote headers, profile links and the text of internal links such as "#12 by name". They do not cover names written inside a post's free text. A user who writes "thanks, Maria" gives Maria's name to your model provider, and lurkd does not try to detect it. When a Discourse forum does not serve the topic JSON, lurkd falls back to Readability on the page, and names in the page chrome are not pseudonymised there. The thread's front matter says so.

## Data on disk

Everything is under `~/.lurkd/`, or under the folder named by `LURKD_HOME`, with mode 0700:

- `archive.db`: the SQLite archive with threads, posts under real names, settings and the fetch log.
- `profiles/default/`: the browser profile with your cookies.
- `sources/`: sources you added.
- `run/server.json`: process id, port and token of the running server.
- `logs/server.log`: the server log.

The page keeps archived threads for as long as you choose: everything, 30, 90 or 365 days ("Archive settings"). Each source row has "Delete archive" to remove what was read from one source. To remove everything, run `lurkd stop && rm -rf ~/.lurkd`.

## Risks and limits

Read these before you log in to anything you cannot afford to lose.

- The page sets a cookie named `lurkd_token`. Browsers do not scope cookies by port, so that cookie is sent to every service on `localhost`, whatever its port. The server checks the cookie, the `Host` header and the `Origin` header, but a local service that you run could read the token from the request it receives.
- When `lurkd start` opens your browser, the address with the token goes through the command line of `open` (macOS) or `xdg-open` (Linux). For a moment other users on the same machine can see it with `ps`. Use `--no-open` on a shared machine and open the printed address yourself.
- If a forum's own server redirects a request to another host, lurkd detects it and fails the read. The hop has already happened by then, so the browser has made one request to the redirect target.
- `--json` output of `fetch` and `search` is not wrapped as untrusted. It is for scripts. Agents should use the MCP tools or the plain CLI output, which keep the `<untrusted-content>` blocks.
- Pseudonyms do not cover names written in free text (see above).
- The cookie facts above apply: a fixed key, and a folder mode as the only protection.
- lurkd blocks every POST request except a search endpoint a source declares. That block can make Cloudflare-protected forums show more human checks. Each source has a switch, "Let Cloudflare beacons through", for a fixed list of beacon requests. It is off by default.
- Reading a forum with an automated tool may break that forum's rules, and a login-gated forum is more likely to have such rules. Sources whose rules forbid it ship off. Sources marked `unknown` have no stated rule, which does not mean permission. Using lurkd is your decision and your responsibility.
- Windows is not supported. Windsurf and OpenCode are untested. The five named hosts have not yet been tried on real installs, so a host's sandbox may stop the server from starting; in that case run `lurkd start` in a terminal first.

## Contributing a source

Add a YAML file to `sources/<topic>/<id>.yaml`, named after its `id`, and run `npm test`, which validates every seed file. Each source must cite the site's rule on automated access, with four fields under `automation`: `policy`, `rule_url`, `rule_quote` and `checked_at`:

```yaml
automation:
  policy: forbidden        # allowed | forbidden | unknown
  rule_url: https://forum.example.org/rules
  rule_quote: "The exact sentence from the rule, copied verbatim."
  checked_at: 2026-11-09
```

`rule_url` and `checked_at` are always required. `rule_quote` is required for `allowed` and `forbidden`, and must be a verbatim quote. A `forbidden` source must also set `enabled: false`. Use `status: untested` unless you have read it with a real account.

## Licence

Apache-2.0. See `LICENSE`.
