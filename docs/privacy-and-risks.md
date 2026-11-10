# Privacy and risks

## What is stored, and where

Everything is under `~/.lurkd/` (or the folder named by `LURKD_HOME`), mode 0700. The archive is `archive.db`, the browser profile is `profiles/default/`, and sources you added are in `sources/`. lurkd contacts only the forums you read, and downloads Chromium once. There is no account, telemetry or sync.

On the page, "Archive settings" keeps threads for 30, 90 or 365 days or forever, and "Delete archive" on a source row removes what was read from it. To remove everything:

```sh
lurkd stop && rm -rf ~/.lurkd
```

## Pseudonyms

The agent sees authors as `author-` and ten hex characters, with the reputation signals the forum shows. Real names stay in the archive. A per-source switch ("Show real names to the agent") reveals them. Names written in a post's free text are not covered, so they reach your model provider as written. When a Discourse forum does not serve the topic JSON, lurkd falls back to Readability on the page, and names in the page chrome are not pseudonymised there. The thread's front matter says so.

## Cookies

The profile's cookies are encrypted with a fixed key, so the only protection is the folder mode 0700. Anyone who can read the folder can read the cookies. To delete the profile and every saved login:

```sh
lurkd stop && rm -rf ~/.lurkd/profiles/default
```

## Other limits

* The `lurkd_token` cookie is sent to every localhost port, because cookies are not scoped by port.
* The page address, token included, is briefly visible in `ps` to other local users while `open` or `xdg-open` runs. Use `lurkd start --no-open` on a shared machine.
* A redirect decided by a forum's own server is detected and fails the read, but the hop has already happened.
* `--json` output of `fetch` and `search` is not wrapped as untrusted.
* Windows is unsupported. Windsurf and OpenCode are untested.

The [README](https://github.com/rospocroccante/lurkd#risks-and-limits) has the full list.
