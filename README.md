<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" width="96" alt="lurkd logo">
  </picture>
</p>

<h1 align="center">lurkd</h1>

<p align="center">Let your AI coding agent read the forums that AI search tends to miss, public or behind a login, read-only.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/lurkd"><img alt="npm version" src="https://img.shields.io/npm/v/lurkd?logo=npm"></a>
  <a href="LICENSE"><img alt="Licence: Apache-2.0" src="https://img.shields.io/badge/licence-Apache--2.0-blue"></a>
  <a href="docs/getting-started.md#requirements"><img alt="Node 22.20 or later" src="https://img.shields.io/badge/node-%3E%3D22.20-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="tsconfig.json"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white"></a>
  <a href="docs/hosts.md"><img alt="MCP server" src="https://img.shields.io/badge/MCP-server-6E56CF"></a>
  <a href="docs/getting-started.md#requirements"><img alt="Platforms: macOS and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555"></a>
  <a href="https://dev-136.gitbook.io/lurkd/"><img alt="Docs on GitBook" src="https://img.shields.io/badge/docs-GitBook-3884FF?logo=gitbook&logoColor=white"></a>
</p>

<p align="center">
  <a href="docs/getting-started.md">Getting started</a> |
  <a href="docs/hosts.md">Connect your agent</a> |
  <a href="docs/the-page.md">The lurkd page</a> |
  <a href="docs/tools-and-cli.md">Tools and CLI</a> |
  <a href="docs/privacy-and-risks.md">Privacy and risks</a>
</p>

lurkd runs a headless browser on your machine and reads forum threads for your agent, over MCP or the CLI. Many forums need no account. Where a forum puts threads behind a login, you log in once, by hand, in a browser profile that lurkd keeps for itself, and lurkd uses that session only for that forum. If a session expires, lurkd reads what the forum shows without login and says so. Threads come back as Markdown with authors replaced by pseudonyms, and a copy goes into a local archive the agent can search offline. lurkd never posts, never works around bot checks and never sees your password.

## Quick start

```sh
npm i -g lurkd
lurkd start
claude mcp add --scope user lurkd -- lurkd mcp
```

`lurkd start` downloads Chromium once and opens the lurkd page in your browser; `lurkd open` opens it again later. On the page, accept the rules warning of a forum you want read (and log in, if that forum needs it), then ask your agent to "read two threads from home-assistant about Zigbee dropouts". Gemini CLI, Cursor, Codex and Cline are covered in [Connect your agent](docs/hosts.md). `npx lurkd <command>` also works without a global install.

## Tools

| MCP tool | CLI | Does |
|---|---|---|
| `sources.search` | `lurkd sources` | Lists the forums lurkd knows, by topic, name or one of your groups |
| `source.fetch` | `lurkd fetch` | Searches a forum or reads one thread |
| `archive.search` | `lurkd search` | Searches threads already read, offline |
| `session.status` | `lurkd session` | Shows the login state per forum |
| `source.sample` | `lurkd sample` | Describes a page so the agent can draft a new source |
| `author.signals` | `lurkd author` | Shows post count and join date for one pseudonym |

The CLI also has `lurkd add <url>`, which queues a forum for you to analyse on the page, and `lurkd import reddit <file>`, which imports one Reddit thread you saved from your own browser.

## Adding forums

The page has an "Add a forum" panel. Give it the address of a Discourse or XenForo forum and press "Analyse": lurkd recognises the engine, reads up to two rules pages on the same site and fills in a draft for you to check and approve. When the rules forbid automated access, the draft starts as Forbidden with the sentence quoted, and the source stays off until you accept. [Adding a site](docs/adding-a-site.md) has the details and the route for other engines.

## Reddit

lurkd never contacts Reddit. Reddit blocks automated readers, and its User Agreement forbids collecting its content without permission. You can import a thread that you saved yourself from your own browser; see [Importing a Reddit thread](docs/reddit-import.md).

## Good to know

- No legal review of lurkd has been done. Reading a forum with an automated tool may break that forum's rules, so using lurkd is your decision and your responsibility.
- Twelve of the 31 bundled forums forbid automation in their rules and ship switched off.
- Names written inside a post's text are not pseudonymised and reach your model provider as written.
- Forum text arrives inside `<untrusted-content>` blocks, and the skill tells the agent never to follow it.
- The browser profile's cookies use a fixed key, so the folder's 0700 mode is their only protection.
- The page opens from a link that works once, so the server's token stays out of your browser history and the process list. Programs that run as you can still do anything you can.

Read [Privacy and risks](docs/privacy-and-risks.md) before you log in to anything you care about. Changes per version are in [CHANGELOG.md](CHANGELOG.md).

## Licence

Apache-2.0. New forums are welcome as pull requests, each with a cited rule on automation: see [Adding a site](docs/adding-a-site.md).
