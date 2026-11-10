# Getting started

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

The first start downloads Chromium through Playwright, which takes a minute or two and prints a line to stderr. After that it starts one headless browser, a local server on 127.0.0.1 and your default browser, which opens the lurkd page. `lurkd start --no-open` prints the address without opening it, and `lurkd stop` shuts everything down. The address ends in `?t=<token>`. The token is new each time the server starts.

You rarely need to run `lurkd start` yourself. Any tool call or CLI command starts the server if it is not running. The command is useful when you want the page.

Next, [log in](logging-in.md) to a source.
