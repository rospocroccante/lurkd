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
npm i -g ./lurkd-0.2.1.tgz
```

The tarball name carries the version from `package.json`, so use the file name `npm pack` prints if it differs. npm 11 may print an `allowScripts` warning about `prepare`. It is only a warning.

## Updating

The lurkd server asks the npm registry once a day which version is the latest. When a newer one exists, the lurkd page shows a banner, `lurkd status` prints an "Update:" line, and other `lurkd` commands print one line on stderr: "lurkd 0.2.2 is available: run lurkd update". lurkd never updates itself. To install the new version, run this in a terminal:

```sh
lurkd update
```

It shows what it will do and asks before it starts. Then it stops the server, copies `~/.lurkd/archive.db` to `~/.lurkd/backups/archive-<old version>-<UTC time>.db` (mode 0600, folder 0700), runs `npm i -g lurkd@<new version>`, and checks the new install with `lurkd --version`. lurkd update asks the registry for the latest version itself, also when the daily check is off. At the end it prints how to go back: `lurkd stop`, `npm i -g lurkd@<old version>`, an `rm -f` of the archive's `-wal` and `-shm` files, and a `cp` command that puts the backup over the archive, with every path quoted for the shell. The `rm` comes first because SQLite would otherwise replay the newer version's write-ahead log onto the restored file. The backup matters because a newer lurkd may move the archive to a new schema version, which an older lurkd refuses to open. SQLite writes the backup while lurkd holds the archive open, so it is one consistent copy. lurkd update stops the server first, but an agent that calls lurkd while npm runs starts it again: its `lurkd mcp` starts the server on the next tool call. Close your agent sessions before you update, or run `lurkd stop` once more after the update. lurkd update does not delete old backups, so remove them yourself when you no longer need them.

`lurkd update --yes` skips the question. Without a terminal and without `--yes`, it prints the plan and exits 2.

lurkd update works only on a global npm install that your user can write to. When lurkd runs from a clone, through npx or from another package manager, or when the global npm folder belongs to another user, it changes nothing and prints the command to run yourself, such as `npm i -g lurkd@0.2.2`.

A server started before the update keeps running the old code. Any command that talks to it says so: "A lurkd server of version 0.2.1 is running; this command is version 0.2.2, which is newer. Run lurkd stop, then lurkd start." A `lurkd mcp` process also keeps the version it started with, for as long as its agent session lasts, so restart your agent sessions after an update. lurkd update says this at the end. Until then, the agent's tools say that this lurkd is older than the running server and that the agent session needs a restart.

To stop the daily check, switch off "Check for new versions" under "Settings" on the page, or start lurkd with `LURKD_NO_UPDATE_CHECK=1` in the environment.

### Updating automatically through npx

If you would rather have every agent session start the latest release, you can point the MCP entry at npx instead of the global command:

```sh
claude mcp add --scope user lurkd -- npx -y lurkd@latest mcp
```

That choice has costs. Whatever is published as `lurkd` on npm runs on your machine the next time your agent starts, with no question asked, so a compromised npm account or a broken release reaches you at once. A new version may upgrade the archive with no backup made first, and the first call after a release waits for the download. The CLI commands in your shell still run the global install, which can be a different version from the one your agent runs. lurkd update leaves an npx setup alone.

### Upgrading from 0.1.0 or 0.2.0

These versions have no `lurkd update`. Run `lurkd stop`, copy `~/.lurkd/archive.db` somewhere safe if you might go back, then run `npm i -g lurkd@latest`. 0.2.0 and 0.2.1 use the same archive schema (version 6), so moving between them in either direction needs no backup. From 0.1.0, the first start of 0.2.x upgrades the archive in place to version 6 and keeps your threads, sessions and settings. lurkd 0.1.0 cannot open the upgraded archive: its server refuses to start, and `~/.lurkd/logs/server.log` says "archive schema version 6 is newer than this lurkd supports (1)". Put the copy back to go back to 0.1.0.

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
