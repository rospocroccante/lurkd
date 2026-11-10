# Connecting your agent

Every host needs to run `lurkd mcp` over stdio. The server starts lurkd's background process on the first tool call, so you do not need to start anything first. The commands below were checked against each host's documentation. None has been run on a real install yet.

Claude Code, Codex, Cline, Cursor and Gemini CLI are the hosts this version targets. You need one that speaks MCP or can run shell commands.

## The skill

The skill is a short `SKILL.md` that tells the agent how to use lurkd and to treat forum text as data. It lives in `skills/lurkd/` and needs the `lurkd` command from the [install](getting-started.md). The `skills` CLI from Vercel Labs fetches it straight from the repository over Git, so it does not depend on how you installed the package:

```sh
DISABLE_TELEMETRY=1 npx skills add rospocroccante/lurkd --skill lurkd --agent claude-code --global
```

`DISABLE_TELEMETRY=1` stops the CLI from sending anonymous usage data (`DO_NOT_TRACK=1` does the same). Replace `claude-code` with the identifier of your host, such as `codex`, `cline`, `cursor` or `gemini-cli`, and add `--list` to see what the CLI finds before it installs anything. The CLI needs Node 22.20 or later and uses your normal Git credentials for a private repository. These options come from the `skills` documentation at github.com/vercel-labs/skills. The combination with this repository has not been run end to end.

If you would rather not use that CLI, copy `skills/lurkd` from your clone into your host's skills folder. For Claude Code that is `~/.claude/skills/lurkd/`, and for most other hosts `~/.agents/skills/lurkd/`.

## Claude Code

```sh
claude mcp add --scope user lurkd -- lurkd mcp
```

The repository also carries `.claude-plugin/plugin.json` and `.mcp.json`, but there is no marketplace and no install steps for them, and the plugin route is untested. Use the `claude mcp add` command above.

## Gemini CLI

```sh
gemini extensions install https://github.com/rospocroccante/lurkd
```

The extension manifest is `gemini-extension.json`. It registers the server and loads `skills/lurkd/SKILL.md` as context.

## Cursor

Cursor has a plugin manifest in `.cursor-plugin/plugin.json`, which points at `.mcp.json`. To add the server by hand, put this in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "lurkd": { "command": "lurkd", "args": ["mcp"] }
  }
}
```

## Codex

Codex has no manifest in this repository, because its documentation does not show how a plugin registers a local stdio server. Add the server with `codex mcp add lurkd -- lurkd mcp`, or put this in `~/.codex/config.toml`:

```toml
[mcp_servers.lurkd]
command = "lurkd"
args = ["mcp"]
```

## Cline

Cline has no manifest format either. Open the MCP settings from the Cline panel (MCP Servers, Configure, Configure MCP Servers) and add the entry below to `cline_mcp_settings.json`. For the Cline CLI the file is `~/.cline/data/settings/cline_mcp_settings.json`.

```json
{
  "mcpServers": {
    "lurkd": { "command": "lurkd", "args": ["mcp"], "disabled": false, "autoApprove": [] }
  }
}
```

## Other hosts

Windsurf and OpenCode read the same `SKILL.md` and should work with the same server entry, but nobody has tried them.

## Tool names with dots

Some model APIs reject tool names that contain a dot (`sources.search`). If your host fails on that, register the server as `lurkd mcp --tool-names=underscore`, which names the tools `sources_search` and so on. Tool result text still names the dotted forms (for example `source.fetch`), and agents map them to the underscore names.

## If the server will not start

The five named hosts have not yet been tried on real installs, so a host's sandbox may stop the server from starting. In that case run `lurkd start` in a terminal first.

## Sources of these snippets

Codex at learn.chatgpt.com/docs/extend/mcp (the old developers.openai.com/codex/mcp address redirects there), Cline at docs.cline.bot/mcp/configuring-mcp-servers, Cursor at cursor.com/docs/reference/plugins, Gemini CLI at github.com/google-gemini/gemini-cli (docs/extensions).
