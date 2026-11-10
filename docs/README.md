# lurkd

lurkd lets an AI coding agent read forums that sit behind a login. You log in once in a browser profile that lurkd keeps for itself, and the agent then asks for threads through MCP tools or CLI commands. Each thread comes back as Markdown with the post order, quotes and page numbers kept, and a copy goes into a local archive that the agent can search offline.

It is read-only. It does not post, does not work around bot detection, never handles your credentials, and has no bulk export. The project is private until a legal review is done, and it runs on macOS and Linux.

These pages cover the common tasks. The [README](https://github.com/rospocroccante/lurkd#readme) in the repository is the full reference.

1. [Getting started](getting-started.md): install lurkd, add the skill and connect your agent.
2. [Logging in](logging-in.md): log in to a source and keep the session.
3. [Tools and CLI](tools-and-cli.md): what the agent can ask for, and the same commands by hand.
4. [Adding a site](adding-a-site.md): teach lurkd a forum it does not list.
5. [Privacy and risks](privacy-and-risks.md): what is stored, where, and the limits you accept.
