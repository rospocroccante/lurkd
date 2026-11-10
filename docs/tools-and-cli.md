# Tools and CLI

The agent has six MCP tools. Each has a CLI command that prints the same output, so you can run any of them by hand.

| Tool | CLI |
|---|---|
| `sources.search` | `lurkd sources [query] [--topic t]` |
| `source.fetch` | `lurkd fetch <source> (--query q \| --url u)` |
| `archive.search` | `lurkd search <query> [--source id] [--limit n]` |
| `session.status` | `lurkd session [source] [--check]` |
| `source.sample` | `lurkd sample <url> [--draft file]` |
| `author.signals` | `lurkd author <source> <pseudonym>` |

`author.signals` gives the join date and the reputation figures the forum serves. Real Discourse forums do not serve a post count in `/u/<name>.json`, so the output shows "Posts: unknown" there.

## A typical read

1. Search the archive first: `lurkd search "your topic"`. It works offline.
2. If the archive has nothing, find a source: `lurkd sources --topic cybersecurity`.
3. Read from it: `lurkd fetch <source> --query "your topic" --max-threads 2`.
4. If a thread is cut, the output gives a post number. Read on with `--from-post <n>`.

A read stops after 60 requests or 10 minutes, and each source has a daily cap. Ask for a few threads at a time.

## Exit codes

0 done, 2 usage error, 3 you have to act in the lurkd page, 4 a request cap was hit, 1 anything else. `lurkd status` exits 1 when the server is not running.

## About --json

The six tool commands and `lurkd status` take `--json`. For `fetch` and `search` that output is not wrapped as untrusted, so forum text in it carries no marker. Use it in scripts. Agents should use the MCP tools or the plain output, which keep the `<untrusted-content>` blocks.
