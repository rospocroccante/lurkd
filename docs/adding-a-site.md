# Adding a site

lurkd reads Discourse and XenForo forums with a short source file, and you can add one of those from the lurkd page in a minute. Any other engine needs CSS selectors, which your agent can draft. phpBB and vBulletin are accepted as engine names and the one vBulletin source is listed, but a read from either answers `extraction_failed` with "Engine vbulletin is not supported in this version."

## Add a forum from the page

1. Press "Add a forum" in the header of [the lurkd page](the-page.md).
2. Type the address of any page of the forum, starting with `https://`, and press "Analyse". An address without a scheme is read as `https://`.
3. lurkd opens that one page in its headless browser, read-only, and follows no link on it. It recognises Discourse from the page's `generator` meta tag and XenForo from the `XF` id on the page or from the `generator` tag, and fills in the forum name, the base address, the domain, the login and sign-up pages and, for XenForo, the search address.
4. lurkd then reads the forum's rules: for Discourse `/tos` and `/guidelines`, which exist even when the home page does not link them, for XenForo `/help/terms/`, and for any other engine the first link on the page whose path looks like terms or rules. That is at most two more GET requests, on the same host, behind the same read-only guard. The panel lists every rules link it found on the page as well.
5. Choose what the rules say about automated access: Allowed, Forbidden or Unknown. For Allowed and Forbidden, paste the exact sentence from the rules and pick the rules page it comes from. Unknown is the default when lurkd found nothing. Add one or more topics, in lowercase with hyphens (for example `indoor-plants`), and press "Save draft".
6. The draft lands switched off under "Drafts to approve" in the "To do" bar. Check its domains and press "Approve". The source file goes to `~/.lurkd/sources/` with `status: untested`, and the source starts off: switch it on in the table, and accept its warning when the rules are Unknown or Forbidden.

If a source already covers the host, the panel says "Already in lurkd as" and names it. If the page shows a human check, the analysis stops and says so; a login wall does not stop it, and the panel says the page asks for a login, so you can log in once the source is approved. For an engine lurkd does not recognise, the panel says: "lurkd cannot read this engine by itself. Ask your agent to add this site: it will draft the selectors." Then follow [Ask the agent](#ask-the-agent) below.

lurkd refuses addresses on your own machine or network: `localhost`, `127.0.0.1` and other private or reserved IP addresses, names such as `nas.local`, `.lan`, `.internal` or `.home.arpa`, and names without a dot. Before it opens a public name, it looks the name up and refuses it when any address it resolves to is private. It also refuses plain `http`, and addresses that carry a user name or password.

## Forums that forbid automated access

While it reads a rules page, "Analyse" looks for a sentence that forbids automated access: the clause of Discourse's default terms of service ("You may not automate access to the forum, or monitor the forum, such as with a web crawler, browser plug-in or add-on, or other computer program that is not a web browser"), and sentences where words such as scrape, crawl, bot, automated, robot or spider stand next to a prohibition. When it finds one, the form starts with Forbidden chosen and the sentence and its page filled in, and the panel says where the sentence came from. Change the choice if the sentence does not apply.

Every sentence found this way also goes into a log, which the "To do" bar shows as "Forums that forbid automated access". Each entry names the forum, the rules page and the sentence, with two buttons:

- "Add anyway" asks for topics and saves a draft with policy Forbidden and the sentence as the rule quote. The source stays switched off after you approve it, and lurkd reads it only after you switch it on and press "I accept" in its warning.
- "Dismiss" removes the entry.

The search works on English wording and is a heuristic: it can miss a clause, or flag a sentence that is about something else. The choice in the form is yours either way.

## When your agent asks

An agent cannot make lurkd open an address. It can run `lurkd add <url>`, which only queues the address: the "To do" bar shows "Add requests from your agent", and each entry has "Analyse" and "Dismiss". lurkd opens the address when you press "Analyse", and the analysis uses the address shown there, the first one queued for that host. The MCP server has no tool for this.

## Removing a source you added

Choose "Remove" in the row menu of a source you added. It deletes the source file after a confirmation. The threads lurkd archived from it stay until you press "Delete archive". Seed sources cannot be removed; switch them off instead.

## Ask the agent

For a forum on another engine, the agent drafts selectors.

1. Ask your agent to add the site and give it a thread address on that site.
2. The agent calls `source.sample`. It receives the page's tags, classes and ids with no text. For a host that has no source yet, lurkd asks you to open the page first: use the entry under "Sites waiting for a sample" on the lurkd page, then the agent calls again. This way lurkd never loads an address an agent picked on its own.
3. From that the agent writes a YAML source with CSS selectors and submits it through the same tool, with `source.sample` and `draft_yaml`, which on the command line is `lurkd sample <url> --draft file`. lurkd holds the draft's `base_url`, `domains`, `login_url`, `signup_url`, `search_url`, `session_check.url` and `automation.rule_url` to the address rules of "Add a forum": https only, no host on your own machine or network, no user name or password, no Reddit. It also looks up the host of `base_url` and every entry of `domains` in DNS, and refuses a name that resolves to an address on your own machine or network. A draft that breaks one of these rules is refused, and the error names the field.
4. The draft appears under "Drafts to approve". The page shows its domains and any read endpoints. Press "Approve" only if they look right. Until you do, the source stays off. "Approve" runs the same checks again, DNS lookup included, so a draft saved by an earlier version of lurkd is refused on approval if its addresses break the rules.

A source file holds no code. Existing files in the repository's `sources/` folder show the fields, and `src/sources/schema.ts` in the repository is the reference. That file is not part of the installed package. Sources you add yourself live in `~/.lurkd/sources/`.

## Contributing it to the seed list

Add `sources/<topic>/<id>.yaml` and run `npm test`. A source has to cite the site's rule on automated access:

```yaml
automation:
  policy: forbidden        # allowed | forbidden | unknown
  rule_url: https://forum.example.org/rules
  rule_quote: "The exact sentence from the rules, copied verbatim."
  checked_at: 2026-11-09
```

`rule_url` and `checked_at` are always required. `rule_quote` is required for `allowed` and `forbidden`, and must be a verbatim quote. A `forbidden` source must also set `enabled: false`. Use `status: untested` unless you have read it with a real account. `signup_url` is optional: an absolute https address on one of the source's domains, which gives the row a "Sign up" entry. No source may list a Reddit domain.

`npm test` validates every seed file.
