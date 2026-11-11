# lurkd

lurkd lets an AI coding agent read the forums that AI search tends to miss, whether they are public or sit behind a login. It drives a headless browser on your machine, and the agent asks for threads through MCP tools or CLI commands. Each thread comes back as Markdown with the post order, quotes and page numbers kept, authors replaced by pseudonyms, and a copy in a local archive that the agent can search offline.

A login is optional. lurkd reads public forums without one, and uses a session only for a forum that needs it. You create that session yourself, in a browser profile that lurkd keeps for itself. If the session expires, lurkd reads what the forum shows without login and says so in the thread.

It is read-only. It does not post, does not work around bot detection, never handles your credentials, never creates accounts and has no bulk export. It never contacts Reddit. It runs on macOS and Linux. The repository is public at github.com/rospocroccante/lurkd and the package is on npm as `lurkd`. No legal review has been done, and using lurkd is your responsibility.

These pages hold the full detail. The [README](https://github.com/rospocroccante/lurkd#readme) in the repository is the short version, and [CHANGELOG.md](https://github.com/rospocroccante/lurkd/blob/main/CHANGELOG.md) lists the changes per version.

1. [Getting started](getting-started.md): requirements, install, first start and upgrading from 0.1.0.
2. [Connecting your agent](hosts.md): the skill, and MCP setup for Claude Code, Gemini CLI, Cursor, Codex and Cline.
3. [Logging in](logging-in.md): when a forum needs a login, signing up, and switching a source on.
4. [The lurkd page](the-page.md): the "To do" bar, the sources table, groups and bulk switching.
5. [Tools and CLI](tools-and-cli.md): what the agent can ask for, the same commands by hand, exit codes and error codes.
6. [Adding a site](adding-a-site.md): "Add a forum" on the page, the agent's route for other engines, and contributing a source.
7. [Importing a Reddit thread](reddit-import.md): one thread you saved yourself, kept on your machine.
8. [Privacy and risks](privacy-and-risks.md): pseudonyms, cookies and the limits you accept.
9. [Reference](reference.md): status, data on disk, retention, request limits, seed sources and known limits.
