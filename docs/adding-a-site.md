# Adding a site

Discourse and XenForo sites work with a short source file. Any other site needs CSS selectors, and your agent can draft them.

Discourse and XenForo have extractors. phpBB and vBulletin are accepted as engine names and the one vBulletin source is listed, but a read from either answers `extraction_failed` with "Engine vbulletin is not supported in this version." Sites with another engine need selectors, which is what the steps below produce.

## Ask the agent

1. Ask your agent to add a site and give it a thread address on that site.
2. The agent calls `source.sample`. It receives the page's tags, classes and ids with no text. For a host that has no source yet, lurkd asks you to open the page first: use the entry under "Sites waiting for a sample" on the lurkd page, then the agent calls again. This way lurkd never loads an address an agent picked on its own.
3. From that the agent writes a YAML source with CSS selectors and submits it through the same tool, with `source.sample` and `draft_yaml`, which on the command line is `lurkd sample <url> --draft file`.
4. The draft appears under "Drafts to approve". The page shows its domains and any read endpoints. Press "Approve" only if they look right. Until you do, the source stays off.

A source file holds no code. Existing files in the repository's `sources/` folder show the fields, and `src/sources/schema.ts` in the repository is the reference. That file is not part of the installed package. Sources you add yourself live in `~/.lurkd/sources/`.

## Contributing it to the seed list

Add `sources/<topic>/<id>.yaml` and run `npm test`. A source has to cite the site's rule on automated access:

```yaml
automation:
  policy: forbidden        # allowed | forbidden | unknown
  rule_url: https://forum.example.org/rules
  rule_quote: "The exact sentence from the rule, copied verbatim."
  checked_at: 2026-11-09
```

`rule_url` and `checked_at` are always required. `rule_quote` is required for `allowed` and `forbidden`, and must be a verbatim quote. A `forbidden` source must also set `enabled: false`. Use `status: untested` unless you have read it with a real account.

`npm test` validates every seed file.
