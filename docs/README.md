# lurkd

lurkd lets an AI coding agent read forums that sit behind a login. You log in once in a browser profile that lurkd keeps for itself, and the agent then asks for threads through MCP tools or CLI commands. Each thread comes back as Markdown with the post order, quotes and page numbers kept, and a copy goes into a local archive that the agent can search offline.

It is read-only. It does not post, does not work around bot detection, never handles your credentials, and has no bulk export. The project is private until a legal review is done, and it runs on macOS and Linux.

These pages hold the full detail. The [README](https://github.com/rospocroccante/lurkd#readme) in the repository is the short version.

1. [Getting started](getting-started.md): requirements, install and first start.
2. [Connecting your agent](hosts.md): the skill, and MCP setup for Claude Code, Gemini CLI, Cursor, Codex and Cline.
3. [Logging in](logging-in.md): log in to a source and keep the session.
4. [Tools and CLI](tools-and-cli.md): what the agent can ask for, and the same commands by hand.
5. [Adding a site](adding-a-site.md): teach lurkd a forum it does not list, or contribute one.
6. [Privacy and risks](privacy-and-risks.md): pseudonyms, cookies and the limits you accept.
7. [Reference](reference.md): status, data on disk, retention, request limits and seed sources.
