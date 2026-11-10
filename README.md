<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" width="96" alt="lurkd logo">
  </picture>
</p>

<h1 align="center">lurkd</h1>

<p align="center">Let your AI coding agent read login-gated forums, read-only, through a browser profile you control.</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: Apache-2.0" src="https://img.shields.io/badge/licence-Apache--2.0-blue"></a>
  <a href="docs/getting-started.md#requirements"><img alt="Node 22.20 or later" src="https://img.shields.io/badge/node-%3E%3D22.20-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="tsconfig.json"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white"></a>
  <a href="docs/hosts.md"><img alt="MCP server" src="https://img.shields.io/badge/MCP-server-6E56CF"></a>
  <a href="docs/getting-started.md#requirements"><img alt="Platforms: macOS and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555"></a>
  <a href="docs/reference.md#status"><img alt="Status: private preview" src="https://img.shields.io/badge/status-private%20preview-orange"></a>
  <a href="docs/README.md"><img alt="Docs on GitBook" src="https://img.shields.io/badge/docs-GitBook-3884FF?logo=gitbook&logoColor=white"></a>
</p>

<p align="center">
  <a href="docs/getting-started.md">Getting started</a> |
  <a href="docs/hosts.md">Connect your agent</a> |
  <a href="docs/tools-and-cli.md">Tools and CLI</a> |
  <a href="docs/privacy-and-risks.md">Privacy and risks</a>
</p>

You log in once, by hand, in a browser profile that lurkd keeps for itself. Your agent then asks for threads over MCP or the CLI and gets them back as Markdown, with authors replaced by pseudonyms and a copy kept in a local archive it can search offline. lurkd never posts, never works around bot checks and never sees your password.

## Quick start

```sh
git clone https://github.com/rospocroccante/lurkd.git && cd lurkd
npm ci && npm run build && npm pack
npm i -g ./lurkd-0.1.0.tgz
lurkd start
claude mcp add --scope user lurkd -- lurkd mcp
```

`lurkd start` downloads Chromium once and opens the lurkd page. Log in to a forum there, accept its rules warning, then ask your agent to "read two threads from home-assistant about Zigbee dropouts". Gemini CLI, Cursor, Codex and Cline are covered in [Connect your agent](docs/hosts.md). Do not run `npx lurkd`: the npm name is not registered yet.

## Tools

| MCP tool | CLI | Does |
|---|---|---|
| `sources.search` | `lurkd sources` | Lists the forums lurkd knows and their login state |
| `source.fetch` | `lurkd fetch` | Searches a forum or reads one thread |
| `archive.search` | `lurkd search` | Searches threads already read, offline |
| `session.status` | `lurkd session` | Shows the login state per forum |
| `source.sample` | `lurkd sample` | Describes a page so the agent can draft a new source |
| `author.signals` | `lurkd author` | Shows post count and join date for one pseudonym |

## Good to know

- Names written inside a post's text are not pseudonymised and reach your model provider as written.
- Forum text arrives inside `<untrusted-content>` blocks, and the skill tells the agent never to follow it.
- The browser profile's cookies use a fixed key, so the folder's 0700 mode is their only protection.
- Twelve of the 31 bundled forums forbid automation in their rules and ship switched off.

Read [Privacy and risks](docs/privacy-and-risks.md) before you log in to anything you care about.

## Licence

Apache-2.0. New forums are welcome as pull requests, each with a cited rule on automation: see [Adding a site](docs/adding-a-site.md).
