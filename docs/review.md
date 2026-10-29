# AccountHop review — 29 October 2026

Reviewed the popup, settings, account detection, portal import, content scripts, service worker, permissions, and release setup. Changes live on `improve-account-switching`, based on `origin/main` at `94535cc`.

The highest priority was to make account and role selection reliable. A fast switch to the wrong account defeats the purpose of this extension.

| Area | Finding | Change |
| --- | --- | --- |
| Account detection | First matching ID or keyword won, even when other hints disagreed. `prod` also matched `nonprod`. | Check for conflicting IDs, keywords, and roles. Ask for a choice when they conflict. Match keywords at word boundaries. |
| Roles | An explicit account ID skipped its saved role override. | Apply the saved role. Ask when several saved roles fit and no keyword resolves the choice. |
| SSO loops | Returning to a resource consumed its guard, allowing another automatic redirect on reload. Some messages could run before the guard loaded. | Await saved session state and retain the guard for five minutes, per tab and resource. Manual switching still works during that time. |
| Worker restarts | Pending account choices existed only in memory. | Store pending choices in session storage and reject choices from an earlier URL. |
| Failed switches | Tab updates ran without awaiting their result. The UI could report success after a failure. | Await navigation, remove failed guards, show an error, and allow retry. |
| Popup | Long lists lacked search, and switching from another site replaced that tab. | Search names, IDs, and roles; use a compact search with one scrolling area; show roles; open a new tab from other sites. |
| Unknown accounts | The banner offered no useful action without saved accounts. | Allow a one-off account ID in both the banner and popup. |
| Account order | Accounts could not move, and the popup sorted them by name. | Add drag handles with keyboard support, save their order, and follow it in the popup and chooser. Conflicting fallback roles ask for a choice so moving a row cannot silently pick a different role. |
| One account list | Portal imports needed a separate learned list and a promotion step. | Import directly into the editable Accounts table. Migrate existing discovered accounts once; keep names, roles, rules, and order. Reimport without duplicates or lost edits. |
| Settings | Incomplete mappings and a missing default account could save. Full portal links needed manual trimming. | Validate fields, focus the first error, accept pasted portal links, show unsaved changes, and support Ctrl/Cmd+S. |
| Portal import | A fixed delay often scanned before sign-in finished. Broad containers could give several accounts the same label. | Reuse an open portal tab, retry for up to a minute, wait for a stable result, pair names with their IDs in nested account rows, and use embedded account metadata to fill missing names. |
| Storage and startup work | Concurrent learning could lose accounts. Repeated learning rewrote storage, and the popup requested the same data several times. | Serialize account changes, skip unchanged learning writes within a minute, and load popup data with one message. |
| Permissions and privacy | The extension requested broad tab access and fetched remote donation icons. | Remove `tabs`, keep AWS host permissions and `activeTab`, and use local images or text. |
| Checks | No repeatable test suite guarded switching behavior. | Add Node tests, Chromium extension tests, formatting checks, and a CI workflow. |

The settings page now explains when automatic switching happens. The old confidence selector had no useful effect because the detector never reached its medium-confidence heuristic. The saved setting remains intact for compatibility.

**Compatibility checks**

| Consumer or saved data | Result |
| --- | --- |
| Existing local settings and mappings | Keep existing fields, rules, roles, and order. Add optional `portalName` for refreshing imported names and `accountListVersion` for the one-time migration. |
| Existing learned accounts | Migrate names and IDs into `settings.accountMappings` once. Retain private browsing context for suggestions. Removed accounts stay removed. |
| Popup and page banner | Both read the same canonical account list. Settings writes and account discovery run through one worker queue so concurrent updates do not lose new accounts. |
| Session redirect log | Same storage key and timestamp entries; expiry now lasts five minutes. URL fragments distinguish resources. |
| AWS portal links | Same documented shortcut format, with encoded role and destination. No server change or new host permission. |
| Tag release workflow | Still packages only `src/`; development tools and screenshots stay outside the extension. |

**Validation**

46 Node tests cover detection, role choice, invalid input, concurrent learning, redirect guards, worker restart state, navigation errors, imports, and message handling. Twenty Chromium tests load the extension in a fresh profile and cover setup, search, keyboard access, pause/resume, errors, portal import, switching from AWS and other pages, an 80-account list, names in nested portal rows and embedded metadata, importing updated names without replacing custom labels, saving drag order, cancelling a drag, migrating old accounts, direct imports into the Accounts table, and a search header that covers scrolling rows without a gap. Formatting and whitespace checks also pass.

The browser tests use mock AWS console and portal pages. They exercise the extension and Chrome APIs, but do not prove an authenticated sign-in with your company's portal. CI runs these checks on pull requests and pushes to `main`. The results above come from local runs.

Screenshots from the tested mock setup: [popup](screenshots/popup-light.png), [dark popup](screenshots/popup-dark.png), [detected AWS resource](screenshots/popup-console.png), [settings](screenshots/settings.png), [page chooser](screenshots/chooser.png), [imported account names](screenshots/portal-account-names.png), [drag handles](screenshots/mapping-order.png), [popup with eight accounts](screenshots/popup-single-scroll.png), [scrolled search header](screenshots/popup-scrolled.png), and [unified Accounts settings](screenshots/unified-accounts.png).

**Limits and future work**

The detected account belongs to the link; AccountHop does not read the current AWS session identity. Portal import depends on the rendered account list, so hidden or collapsed accounts may need expanding. This version supports standard `*.awsapps.com` portals and `*.console.aws.amazon.com` consoles. Dual-stack `*.portal.<region>.app.aws`, GovCloud, and China endpoints need separate support and testing. No startup or navigation timing benchmark was taken; performance claims here concern fewer messages and storage writes.

The behavior follows the [AWS shortcut-link format](https://docs.aws.amazon.com/singlesignon/latest/userguide/createshortcutlink.html) and Chrome's guidance to [save service worker state](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers). The browser harness follows [Playwright's extension testing guide](https://playwright.dev/docs/chrome-extensions).
