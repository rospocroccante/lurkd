# Logging in

The lurkd page lists every source with its login state: "Logged in", "Session expired", "Switched off", "Not logged in" or "No login needed". The agent reads a source only with a session you created yourself.

1. Run `lurkd start` if the page is not open.
2. Press "Log in" next to the source. A browser window opens on the site's login page.
3. Log in as you normally do, 2FA included.
4. Press "Done" on the lurkd page. The window closes, lurkd checks the session with one request, and the row reads "Logged in".

lurkd does not read or store what you type. It keeps only the cookies, in its own profile on disk.

Sessions are kept in the profile on disk, so they are meant to survive `lurkd stop` and a restart. That has not yet been tried with a real account.

## Switching on a source

Twelve of the seed sources forbid automated access in their own rules and ship switched off. To switch one on, the page quotes the rule and asks you to press "I accept". Think about whether your account is worth the risk first.

Sources marked `unknown` have no clear rule on automation. They start switched on, but reads are refused with `needs_acknowledgment` until you accept. Press "Read the warning" on the row, read the rule line and the link, and press "I accept" if you take the decision.

## Human checks and expired sessions

If a forum shows a human check during a read, the read stops and the row offers "Open window". Solve the check yourself and press "Done". lurkd never tries to solve it.

To ask a forum whether a session still works:

```sh
lurkd session <source> --check
```

An expired session shows as such on the page. Press "Log in" again.
