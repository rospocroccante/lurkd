# Getting started

You need macOS or Linux and Node 22.20 or later. Windows is not supported.

## Install

The package is not on npm yet, and `npm i -g github:rospocroccante/lurkd` fails on npm 11, so build a tarball from a clone. The repository is private, so the clone needs a GitHub login that can read it:

```sh
git clone https://github.com/rospocroccante/lurkd.git
cd lurkd
npm ci
npm run build
npm pack
npm i -g ./lurkd-0.1.0.tgz
lurkd --version
```

The version in the file name comes from `package.json`. npm 11 may print an `allowScripts` warning about `prepare`, which is only a warning. better-sqlite3 ships prebuilt binaries for macOS and Linux (x64, arm64 and musl), so you need no compiler.

Do not run `npx lurkd`. The name is unregistered on npm, so npx would run whatever package someone else publishes under it.

## Add the skill

```sh
DISABLE_TELEMETRY=1 npx skills add rospocroccante/lurkd --skill lurkd --agent claude-code --global
```

The CLI fetches the skill from the repository over Git, whatever way you installed the package. Swap `claude-code` for `codex`, `cline`, `cursor` or `gemini-cli`, and add `--list` first to see what it finds. If you prefer to copy by hand, put `skills/lurkd` from your clone into your host's skills folder.

## Connect your agent

Every host runs `lurkd mcp` over stdio. For Claude Code:

```sh
claude mcp add --scope user lurkd -- lurkd mcp
```

Gemini CLI installs the repository as an extension with `gemini extensions install https://github.com/rospocroccante/lurkd`. Cursor, Codex and Cline take a small config entry, which the README shows for each. If a host rejects tool names that contain a dot, register `lurkd mcp --tool-names=underscore` instead. Tool result text still names the dotted forms (for example `source.fetch`), and agents map them to the underscore names.

## First start

```sh
lurkd start
```

The first start downloads Chromium, then opens the lurkd page in your default browser. After that, any tool call or CLI command starts the server when it is not running. `lurkd stop` shuts it down.
