# Tools and CLI

The agent has six MCP tools. Each has a CLI command that prints the same output, so you can run any of them by hand.

| Tool | CLI | What it does |
|---|---|---|
| `sources.search` | `lurkd sources [query] [--topic t]` | Lists sources by topic or name, with login state and status. |
| `source.fetch` | `lurkd fetch <source> (--query q \| --url u)` | Searches one source, or reads one thread by address. |
| `archive.search` | `lurkd search <query> [--source id] [--limit n]` | Searches threads already read, offline. |
| `session.status` | `lurkd session [source] [--check]` | Shows the login state per source. |
| `source.sample` | `lurkd sample <url> [--draft file]` | Returns a page's structure without text, or submits a drafted source. |
| `author.signals` | `lurkd author <source> <pseudonym>` | Gives total posts and join date for one pseudonymised author. |

Each thread comes back as Markdown that keeps the order of the posts, the quotes and the page numbers, and everything read is saved in the local archive.

`author.signals` gives the join date and the reputation figures the forum serves. Real Discourse forums do not serve a post count in `/u/<name>.json`, so the output shows "Posts: unknown" there.

## A typical read

1. Search the archive first: `lurkd search "your topic"`. It works offline.
2. If the archive has nothing, find a source: `lurkd sources --topic cybersecurity`.
3. Read from it: `lurkd fetch <source> --query "your topic" --max-threads 2`.
4. If a thread is cut, the output says where to continue. Pass that number as `--from-post <n>`.

`lurkd fetch` also takes `--max-threads n`, `--refresh`, `--from-post n` and `--max-chars n`.

A read stops after 60 requests or 10 minutes, and each source has a daily cap. Ask for a few threads at a time.

## Exit codes

0 done, 2 usage error, 3 you have to act in the lurkd page, 4 a request cap was hit, 1 anything else. `lurkd status` exits 1 when the server is not running.

## About --json

The six tool commands and `lurkd status` take `--json`. For `fetch` and `search` that output is not wrapped as untrusted, so forum text in it carries no marker. Use it in scripts. Agents should use the MCP tools or the plain output, which keep the `<untrusted-content>` blocks.

## Untrusted content

Text from the forum arrives inside `<untrusted-content>` blocks. The skill tells the agent to treat it as data and never to follow instructions found in it.
