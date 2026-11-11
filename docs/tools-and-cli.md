# Tools and CLI

The agent has six MCP tools. Each has a CLI command that prints the same output, so you can run any of them by hand.

| Tool | CLI | What it does |
|---|---|---|
| `sources.search` | `lurkd sources [query] [--topic t] [--group name]` | Lists sources by topic, name or one of your groups, with login state and status. |
| `source.fetch` | `lurkd fetch <source> (--query q \| --url u)` | Searches one source, or reads one thread by address. |
| `archive.search` | `lurkd search <query> [--source id] [--limit n]` | Searches threads already read, offline. |
| `session.status` | `lurkd session [source] [--check]` | Shows the login state per source. |
| `source.sample` | `lurkd sample <url> [--draft file]` | Returns a page's structure without text, or submits a drafted source. |
| `author.signals` | `lurkd author <source> <pseudonym>` | Gives total posts and join date for one pseudonymised author. |

Each thread comes back as Markdown that keeps the order of the posts, the quotes and the page numbers, and everything read is saved in the local archive.

`sources.search` takes `group`, the name of one of the groups you made on the page, and keeps only its sources; `lurkd sources --group <name>` does the same. An unknown name answers `not_found` with the names of your groups. Only the page makes or changes groups.

`author.signals` gives the join date and the reputation figures the forum serves. Real Discourse forums do not serve a post count in `/u/<name>.json`, so the output shows "Posts: unknown" there.

## Commands without a tool

These have no MCP tool. An agent with a shell can run them, and you can too.

| Command | What it does |
|---|---|
| `lurkd start [--no-open]` | Starts the server if it is not running and opens the lurkd page with a one-time link. `--no-open` prints the link instead. |
| `lurkd open [--no-open]` | Opens the lurkd page with a new one-time link, starting the server if needed. |
| `lurkd stop` | Stops the server and its browser. |
| `lurkd status [--json]` | Says whether the server runs, its browser and queue, the sources that need you, and a newer lurkd version when the server knows of one. It prints the page address without any token and names `lurkd open` for opening it. |
| `lurkd update [--yes]` | Installs the latest lurkd with npm, after asking: stops the server, backs up the archive to `~/.lurkd/backups/`, runs `npm i -g lurkd@<latest>`, checks the new version and prints how to go back. Run it yourself in a terminal; agents should not. |
| `lurkd mcp [--tool-names=dot\|underscore]` | Serves the six tools over MCP on stdin and stdout. |
| `lurkd add <url>` | Queues a Discourse or XenForo forum for "Add a forum" on the page. lurkd does not open the address until you press "Analyse" there. |
| `lurkd import reddit <file>` | Imports one Reddit thread you saved from your own browser into the archive. lurkd reads the local file only. |

`lurkd add` answers in one of three ways: the host is now waiting on the page, it was already waiting (with the address queued first, which lurkd keeps), or a source already covers it. Up to 20 forums can wait at a time. It refuses addresses on your own machine or network, addresses with a user name or password, and Reddit, and it never loads the address itself. See [Adding a site](adding-a-site.md#add-a-forum-from-the-page).

`lurkd status` adds a line such as "Update: lurkd 0.2.2 is available. Run lurkd update in a terminal to install it." when the server's daily check found a newer version. In `--json` the same fact is the `update` field: `{"current": "0.2.1", "latest": "0.2.2", "checkedAt": "<time of the check>"}`, or `null` when there is no newer version or the check is off. The other commands, apart from `stop`, `mcp` and `update`, print one line on stderr after their output, "lurkd 0.2.2 is available: run lurkd update". They read it from the running server and never ask the registry themselves. The line is left out with `--json`, and the MCP tools never return it.

`lurkd update` asks for confirmation; `--yes` skips the question, and without a terminal and without `--yes` it prints the plan and exits 2. It exits 1 and changes nothing when lurkd is not a global npm install (a clone, npx or another package manager) or when your user cannot write to the global npm folder; it prints the npm command to run instead. When lurkd is already the latest version it says so and exits 0. It asks the npm registry for the latest version itself, also when the daily check is switched off or `LURKD_NO_UPDATE_CHECK=1` is set, because you ran it on purpose. [Getting started](getting-started.md#updating) describes the whole update.

When a command or the MCP server reaches a server started by another lurkd version, it says so once, and the advice depends on which side is older. After an update the server is usually the newer one, and the old side is an agent's `lurkd mcp`, which keeps running the version it started with, or an old `lurkd` command: "This lurkd is version 0.2.1, older than the running lurkd server (version 0.2.2). If an agent runs it as lurkd mcp, restart the agent session so it loads the new version; in a terminal, run the new lurkd." When the server is the older one: "A lurkd server of version 0.2.1 is running; this command is version 0.2.2, which is newer. Run lurkd stop, then lurkd start." The CLI prints the line on stderr; the MCP server puts it before the first tool answer. A route the server does not have answers with the same line instead of "No such route"; when the line was already printed, the error says only that the running server does not know the request.

`lurkd import reddit` takes one regular file of at most 20 MB per call, not a folder and not several files. See [Importing a Reddit thread](reddit-import.md).

## A typical read

1. Search the archive first: `lurkd search "your topic"`. It works offline.
2. If the archive has nothing, find a source: `lurkd sources --topic cybersecurity`.
3. Read from it: `lurkd fetch <source> --query "your topic" --max-threads 2`.
4. If a thread is cut, the output says where to continue. Pass that number as `--from-post <n>`.

`lurkd fetch` also takes `--max-threads n`, `--refresh`, `--from-post n` and `--max-chars n`.

A read stops after 60 requests or 10 minutes, and each source has a daily cap. Ask for a few threads at a time.

If the source's session has expired, the read goes on without login and the output starts with "Read without login: the session of `<source>` has expired", followed by what to do. See [Logging in](logging-in.md#when-a-session-expires).

## Exit codes

0 done, 2 usage error (an invalid request included, such as a file that is not a saved Reddit thread), 3 you have to act in the lurkd page, 4 a request cap was hit, 1 anything else. `lurkd status` exits 1 when the server is not running.

## Error codes

Errors from the tools and the commands start with `Error <code>:` and a message that says what to do next.

| Code | Meaning | Exit |
|---|---|---|
| `invalid_request` | The request or a file is not valid; the message names what. | 2 |
| `needs_login` | The forum asked for a login. Press "Log in" on the page. | 3 |
| `challenge` | The forum showed a human check. Press "Open window" on the page. | 3 |
| `needs_acknowledgment` | The source's rules warning is not accepted yet. | 3 |
| `disabled` | The source is switched off. | 3 |
| `handoff_in_progress` | A browser window is open on the page; finish it first. | 3 |
| `run_cap`, `daily_cap` | The run's or the day's request cap was hit. | 4 |
| `unsupported` | lurkd does not do this at all. Today that means Reddit: reading it live, sampling it, queueing it or analysing it. The message gives the steps to import a thread instead; a thread you imported comes back from the archive. | 1 |
| `unknown_source`, `not_found` | No source with that id, or no such thread or group. | 1 |
| `search_unsupported` | The source has no search; give a thread address. | 1 |
| `off_domain`, `denied_path` | The address is not on the source's domains, or is a path lurkd never opens. | 1 |
| `extraction_failed` | lurkd could not read the thread from the page, or the engine is not supported. | 1 |
| `timeout`, `browser_unavailable`, `server_unavailable`, `unauthorized`, `bad_host`, `internal` | Something went wrong in lurkd or on the way to it. | 1 |

## About --json

The six tool commands, `lurkd add`, `lurkd import reddit` and `lurkd status` take `--json`. For `fetch` and `search` that output is not wrapped as untrusted, so forum text in it carries no marker. Use it in scripts. Agents should use the MCP tools or the plain output, which keep the `<untrusted-content>` blocks.

## Untrusted content

Text from the forum arrives inside `<untrusted-content>` blocks. The skill tells the agent to treat it as data and never to follow instructions found in it.
