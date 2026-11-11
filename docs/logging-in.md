# Logging in

A login is optional. lurkd reads a forum without one whenever the forum shows its threads to visitors, and many do. Log in only to a forum that hides the threads you want behind a login. lurkd then uses that session for that forum and no other.

The Session column of [the lurkd page](the-page.md) shows the state of each source: "Logged in", "Session expired", "Switched off", "Not logged in" or "No login needed". "No login needed" means the source names no login page at all.

## Logging in to a source

1. Run `lurkd open` if the page is not open.
2. Open the row menu of the source and choose "Log in". A browser window opens on the site's login page.
3. Log in as you normally do, 2FA included.
4. Press "Done" on the lurkd page. The window closes, lurkd checks the session with one request, and the row reads "Logged in".

lurkd does not read or store what you type. It keeps only the cookies, in its own profile on disk. "Cancel" closes the window without a check, and a window left open closes by itself after 15 minutes.

Sessions are kept in the profile on disk, so they are meant to survive `lurkd stop` and a restart. That has not yet been tried with a real account.

## Signing up

A source that names a sign-up page and has no session offers "Sign up" in its row menu. It opens the same window on the forum's registration page. You register there by hand, CAPTCHA and email confirmation included, and press "Done"; lurkd then checks the session as it does after a login. lurkd never creates an account for you and never fills in a registration form.

"Add a forum" fills in the sign-up page for the Discourse (`/signup`) and XenForo (`/register/`) forums it adds. The seed sources do not list one yet, so their rows show "Log in" only.

## When a session expires

An expired session does not stop a read. lurkd reads the forum without login and gets what the forum shows to visitors. The thread's front matter then has the line `note: "read without login: the session expired"`, the agent is told the same in the tool result, and the row on the page keeps "Session expired" (it also counts under "Sessions expired" in the "To do" bar). If the forum asks for a login during that read, the read stops with `needs_login`, as for a source that was never logged in. To read as yourself again, choose "Log in" again.

The note is written only on the answer to that read. A later read of the same thread from the archive does not carry it.

To ask a forum whether a session still works:

```sh
lurkd session <source> --check
```

## Human checks

If a forum shows a human check during a read, the read stops and the row menu offers "Open window". Solve the check yourself and press "Done". lurkd never tries to solve it.

## Switching on a source

Twelve of the seed sources forbid automated access in their own rules and ship switched off. To switch one on, use its switch: the page quotes the rule and asks you to press "I accept". Think about whether your account is worth the risk first.

Sources marked `unknown` have no clear rule on automation. They start switched on, but reads are refused with `needs_acknowledgment` until you accept. Choose "Read the warning" in the row menu, read the rule line and the link, and press "I accept" if you take the decision.

To switch on many sources at once, tick their boxes or use a group switch; [the lurkd page](the-page.md#switching-sources-in-bulk) says which sources go on at once and which need your acceptance first.
