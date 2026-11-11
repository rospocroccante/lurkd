# Getting started

## Requirements

- macOS or Linux. Windows is not supported.
- Node 22.20 or later.
- Network access on the first start, to download Chromium.
- An AI coding agent that speaks MCP or can run shell commands. Claude Code, Codex, Cline, Cursor and Gemini CLI are the hosts this version targets. [Connecting your agent](hosts.md) says which of them has been tried on a real install.

## Install

```sh
npm i -g lurkd
lurkd --version
```

The one native dependency, better-sqlite3, ships prebuilt binaries for macOS and Linux (x64, arm64 and musl), so no compiler is needed. `npx lurkd <command>` runs the published package without a global install, but the MCP entries in [Connecting your agent](hosts.md) call the `lurkd` command, so a global install is the simpler choice.

### From a clone instead

To run the code from the repository, build a tarball and install that. `npm i -g github:rospocroccante/lurkd` does not work on npm 11: the global install of a Git dependency runs the `prepare` build without the dev dependencies, so the TypeScript compiler is missing.

```sh
git clone https://github.com/rospocroccante/lurkd.git
cd lurkd
npm ci
npm run build
npm pack
npm i -g ./lurkd-0.2.0.tgz
```

The tarball name carries the version from `package.json`, so use the file name `npm pack` prints if it differs. npm 11 may print an `allowScripts` warning about `prepare`. It is only a warning.

## Upgrading from 0.1.0

```sh
lurkd stop
npm i -g lurkd@0.2.0
```

On its first start, 0.2.0 upgrades the archive at `~/.lurkd/archive.db` in place to schema version 6. Your threads, sessions and settings stay. lurkd 0.1.0 cannot open an upgraded archive: its server refuses to start, the terminal says "Could not start the lurkd server", and `~/.lurkd/logs/server.log` holds the reason, "archive schema version 6 is newer than this lurkd supports (1)". If you might go back to 0.1.0, copy `~/.lurkd/archive.db` somewhere safe after `lurkd stop` and before the install.

This works the same whether 0.1.0 came from npm or from a tarball: the global `lurkd` command is replaced.

## Add the skill and connect your agent

The skill tells the agent how to use lurkd and to treat forum text as data. The MCP server entry is the same for every host, `lurkd mcp` over stdio. For Claude Code:

```sh
claude mcp add --scope user lurkd -- lurkd mcp
```

[Connecting your agent](hosts.md) has the skill install and the setup for Gemini CLI, Cursor, Codex and Cline, plus the underscore tool names for hosts that reject dots.

## First start

```sh
lurkd start
```

The first start downloads Chromium through Playwright, which takes a minute or two and prints a line to stderr. After that it starts one headless browser and a local server on 127.0.0.1, and opens the lurkd page in your default browser. `lurkd stop` shuts everything down.

The page opens from a link that works once, within 60 seconds, and never holds the server's token. If you close the tab or restart lurkd, run `lurkd open` for a new link; it starts the server too when it is not running. `lurkd start --no-open` and `lurkd open --no-open` print the link instead of opening it. [Privacy and risks](privacy-and-risks.md#risks-and-limits) says what the single-use link protects and what it does not.

You rarely need to run `lurkd start` yourself. Any tool call or CLI command starts the server if it is not running. When you want the page, run `lurkd open`.

Next, switch on a source on [the lurkd page](the-page.md), and [log in](logging-in.md) to it if the forum needs a login.
