# AccountHop for AWS

A Chrome extension that redirects AWS console links through your company's SSO portal so you land in the correct account — no more 403s.

## Demo

[![Watch the AccountHop demo](./images/AccountHop-thumbnail.PNG)](https://youtu.be/mW5gblS45G8)

See AccountHop detect the target AWS account from the URL and redirect through IAM Identity Center so the correct console resource opens without manual account switching.

## Install

Install from the chrome extensions store: [AccountHop for AWS](https://chromewebstore.google.com/detail/mlkmbmoehpnifbllgklomdjjoiaifmjm?utm_source=item-share-cb)

OR

1. Clone this repo
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select the `src/` directory
4. Click the extension icon → **Settings** to configure

## Setup

Set your portal and default role, then import or add your accounts:

| Setting | Example | Notes |
|---------|---------|-------|
| **Portal URL** | `mycompany.awsapps.com` | Paste the full portal URL or enter its hostname |
| **Default Role** | `Developer` | The permission set name from your portal |
| **Accounts** | Production → `123456789012` | Import names and IDs from your portal, or add them by hand |

Click **Import from Portal** in the **Accounts** section to fill the account table with names and IDs. Click **Save Settings** to keep the changes. You can also add an account by hand.

Each account has a **Name**, **Account ID**, optional **Role Override**, and optional **URL keyword**. Leave the keyword blank for manual switching. Imported accounts start with blank keywords.

Drag an account’s handle to change its order, then save. You can also focus the handle and press **Alt+Up** or **Alt+Down**. The popup and account chooser follow the same order.

## How It Works

When you open an AWS console link, the extension:

1. **Detects the account** — looks for a 12-digit account ID in the URL (query params, path, ARN, embedded service URLs)
2. **Checks your mappings** — if no ID appears in the URL, matches whole words against your keyword rules. For example, `prod` matches `my-prod-queue` but not `nonprod`. Conflicting account hints always open the chooser.
3. **Redirects through the portal** — builds a deep link like `https://portal/start/#/console?account_id=...&role_name=...&destination=...`
4. **You land on the resource** in the correct account context

If the extension can't determine the account, it follows your fallback setting: show the chooser, do nothing, or use your default account. Conflicting hints always ask you to choose. The chooser also accepts an account ID that you have not saved.

Open the popup to search accounts by name, ID, or role. On an AWS console page, switching keeps the current resource link. From any other page, it opens AWS in a new tab. The account shown for a link is its detected target; it does not prove which account you are currently signed into.

After a redirect, AccountHop leaves the same resource alone in that tab for five minutes to prevent SSO loops. You can still switch manually from the popup during that time.

## Managing accounts

All accounts live in the same **Accounts** list. Accounts you already had in the old learned list move into it when the extension first loads the new version. Accounts remembered while switching also appear there.

Import again to refresh portal names. Your custom names, keyword rules, role overrides, and order stay intact. Reimporting the same accounts does not create duplicates. Imports join the current settings draft, so other unsaved edits stay in place.

Browsing history can suggest an account, but suggestions always ask you to choose. Only an explicit account ID in the URL or an unambiguous keyword rule triggers automatic switching.

## Privacy

Settings, accounts, and browsing context stay in local Chrome storage. AccountHop sends your chosen account ID, role, and console destination to your configured AWS access portal when you switch. It sends no analytics and loads no remote images. It uses AWS domain permissions and temporary access to the current tab when you open the popup; it does not request the broad `tabs` permission.

## Support

If AccountHop makes your day a little easier and you want to help support future improvements, [buy me a coffee](https://buymeacoffee.com/coreyhayward).

## Development and checks

The extension runs directly from `src/`, with no build step or runtime packages. Development tools require Node.js 24 or later.

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
npm run format:check
```

Browser tests load the extension in a fresh Chromium profile and serve mock AWS console and portal pages. They do not sign in to a real AWS account. Screenshots appear under `test-results/`. CI runs the same checks on pull requests and pushes to `main`.

To try a local change, load `src/` as an unpacked extension, or click **Reload** on its card at `chrome://extensions`. Refresh open AWS console and portal tabs so they use the updated content scripts.

The [review notes](docs/review.md) explain the fixes, compatibility choices, and test limits.


## Releases

Pushing a version tag such as `v1.1.0` runs the release workflow. It copies `src/`, sets the packaged manifest version from the tag, and attaches the ZIP to a GitHub release.

Chrome Web Store publishing is manual: download that ZIP, open the extension in the Developer Dashboard, choose **Package → Upload New Package**, and submit the update for review. Each uploaded package must have a higher version than the previous one. See the [Chrome Web Store update guide](https://developer.chrome.com/docs/webstore/update).
