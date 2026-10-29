const { test: base, expect, chromium } = require('@playwright/test');
const { join } = require('node:path');

const settings = {
  enabled: true,
  portalUrl: 'company.awsapps.com',
  roleName: 'Developer',
  accountMappings: [
    { keyword: 'prod', accountId: '123456789012', label: 'Production', roleName: 'ReadOnly' },
    { keyword: 'dev', accountId: '210987654321', label: 'Development', roleName: '' },
    { keyword: 'live', accountId: '123456789012', label: 'Production', roleName: 'ReadOnly' },
  ],
  fallbackBehavior: 'prompt',
};
const test = base.extend({
  extension: async ({}, use, testInfo) => {
    const path = join(__dirname, '..', '..', 'src');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
      viewport: { width: 1000, height: 850 },
    });
    await context.route('https://**/*', async (route) => {
      const portal = new URL(route.request().url()).hostname.endsWith('.awsapps.com');
      await route.fulfill({
        contentType: 'text/html',
        body: portal
          ? '<title>Mock AWS portal</title><main data-testid="accounts"><article class="account"><h2>Production</h2><p>123456789012</p></article><article class="account"><h2>Development</h2><p>210987654321</p></article></main>'
          : '<title>Mock console</title><main><h1>AWS console test page</h1></main>',
      });
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const id = worker.url().split('/')[2];
    await worker.evaluate((settings) => chrome.storage.local.set({ settings }), settings);
    const errors = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await use({ context, worker, url: `chrome-extension://${id}`, testInfo });
    await context.close();
    expect(errors).toEqual([]);
  },
});

async function openPage(extension, path) {
  const page = await extension.context.newPage();
  await page.goto(`${extension.url}/${path}`);
  return page;
}

test('popup searches and deduplicates accounts, supports keyboard access and pause/resume', async ({
  extension,
}) => {
  const page = await openPage(extension, 'popup/popup.html');
  await expect(page.locator('.btn-account')).toHaveCount(2);
  await expect(page.locator('#accountSearch')).toBeFocused();
  await page.getByRole('searchbox').fill('ReadOnly');
  await expect(page.locator('.btn-account')).toHaveCount(1);
  await page.getByRole('searchbox').press('ArrowDown');
  await expect(page.locator('.btn-account')).toBeFocused();
  await page.getByRole('searchbox').fill('missing');
  await expect(page.getByText('No accounts match.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Enable AccountHop' }).uncheck();
  await expect(page.getByText('AccountHop is paused', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Enable AccountHop' }).check();
  await expect(page.locator('#workspace')).toBeVisible();
  await page.getByRole('searchbox').fill('');
  await page
    .locator('.popup')
    .screenshot({ path: extension.testInfo.outputPath('popup-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page
    .locator('.popup')
    .screenshot({ path: extension.testInfo.outputPath('popup-dark.png') });
});

test('switching from another page opens a new tab through SSO', async ({ extension }) => {
  const source = await extension.context.newPage();
  await source.goto('https://example.com/keep-this-tab');
  const page = await openPage(extension, 'popup/popup.html');
  await expect(page.locator('.btn-account')).toHaveCount(2);
  const newPage = extension.context.waitForEvent('page');
  await page.getByRole('button', { name: /Production/ }).click();
  const target = await newPage;
  await target.waitForURL('https://company.awsapps.com/**');
  expect(source.url()).toBe('https://example.com/keep-this-tab');
  const params = new URLSearchParams(new URL(target.url()).hash.split('?')[1]);
  expect(params.get('role_name')).toBe('ReadOnly');
  expect(params.get('destination')).toBe('https://console.aws.amazon.com/');
  await target.goto(params.get('destination'));
  await expect(target).toHaveURL('https://console.aws.amazon.com/');
  await expect(target.locator('#aws-auto-login-banner-host')).toHaveCount(0);
});

test('failed switch stays open with a useful error and a working retry', async ({ extension }) => {
  const page = await openPage(extension, 'popup/popup.html');
  await expect(page.locator('.btn-account')).toHaveCount(2);
  await extension.worker.evaluate(
    (settings) => chrome.storage.local.set({ settings: { ...settings, enabled: false } }),
    settings,
  );
  await page.getByRole('button', { name: /Production/ }).click();
  await expect(page.getByRole('alert')).toContainText('enable AccountHop');
  await expect(page.getByRole('button', { name: /Production/ })).toBeEnabled();
});

test('first run shows setup, and empty accounts support manual entry', async ({ extension }) => {
  await extension.worker.evaluate(() => chrome.storage.local.clear());
  const page = await openPage(extension, 'popup/popup.html');
  await expect(page.getByRole('button', { name: 'Set up AccountHop' })).toBeVisible();
  await extension.worker.evaluate(
    (settings) => chrome.storage.local.set({ settings: { ...settings, accountMappings: [] } }),
    settings,
  );
  await page.reload();
  await expect(page.locator('#emptyAccounts')).toContainText('No accounts yet');
  await page.getByText('Use another account ID').click();
  await page.getByLabel('AWS account ID', { exact: true }).fill('333333333333');
  const opened = extension.context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const target = await opened;
  await target.waitForURL('https://company.awsapps.com/**');
  expect(target.url()).toContain('333333333333');
});

test('options validates portal, mappings and default account, then saves a pasted portal URL', async ({
  extension,
}) => {
  const page = await openPage(extension, 'options/options.html');
  await page.locator('#portalUrl').fill('https://evil.test/');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.locator('#portalUrl')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#portalUrl')).toBeFocused();
  await page.locator('#portalUrl').fill('https://company.awsapps.com/start/#/accounts');
  await page.getByRole('radio', { name: 'Use default account', exact: true }).check();
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.locator('#defaultAccountId')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#defaultAccountId').fill('123456789012');
  await page.getByRole('button', { name: '+ Add account' }).click();
  await page.getByLabel('URL keyword (optional)', { exact: true }).last().fill('test');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.getByLabel('AWS account ID', { exact: true }).last()).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.getByLabel('AWS account ID', { exact: true }).last().fill('333333333333');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Settings saved');
  const saved = await extension.worker.evaluate(
    async () => (await chrome.storage.local.get('settings')).settings,
  );
  expect(saved.portalUrl).toBe('company.awsapps.com');
  expect(saved.accountMappings.at(-1).accountId).toBe('333333333333');
  await page.screenshot({ path: extension.testInfo.outputPath('settings.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 850 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test('portal import reuses the signed-in tab and imports its account labels', async ({
  extension,
}) => {
  const portal = await extension.context.newPage();
  await portal.goto('https://company.awsapps.com/start/');
  const page = await openPage(extension, 'options/options.html');
  const before = extension.context.pages().length;
  await page.getByRole('button', { name: 'Import from Portal' }).click();
  await expect(page.locator('#importStatus')).toHaveText(
    'Imported 2 accounts. Save Settings to keep them.',
    {
      timeout: 10000,
    },
  );
  expect(extension.context.pages().length).toBe(before);
  await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Learned Accounts', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Account name', { exact: true }).first()).toHaveValue('Production');
  await expect(page.getByLabel('Account name', { exact: true }).nth(1)).toHaveValue('Development');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Settings saved');
});

test('real navigation redirects once through the portal and keeps the full resource link', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  const destination =
    'https://eu-central-1.console.aws.amazon.com/sqs/v3/home?accountId=123456789012#/queues/prod';
  await page.goto(destination).catch((error) => {
    if (!/interrupted|ERR_ABORTED/.test(error.message)) throw error;
  });
  await expect(page).toHaveURL(/^https:\/\/company\.awsapps\.com\//);
  const params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
  expect(params.get('destination')).toBe(destination);
  expect(params.get('role_name')).toBe('ReadOnly');
  await page.goto(destination);
  await expect(page).toHaveURL(destination);
  await expect(page.locator('#aws-auto-login-banner-host')).toHaveCount(0);
});

test('unknown account shows the chooser but paused extension stays out of the console', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  await page.goto('https://console.aws.amazon.com/s3/');
  await expect(page.locator('#aws-auto-login-banner-host')).toHaveCount(1);
  await page.screenshot({ path: extension.testInfo.outputPath('chooser.png') });
  await extension.worker.evaluate(
    (settings) => chrome.storage.local.set({ settings: { ...settings, enabled: false } }),
    settings,
  );
  await page.reload();
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('#aws-auto-login-banner-host')).toHaveCount(0);
});

test('popup identifies an AWS link and switches that tab without losing the resource', async ({
  extension,
}) => {
  const destination = 'https://console.aws.amazon.com/sqs/?account=123456789012#/queues/example';
  const tabId = await extension.worker.evaluate(
    async ({ destination, settings }) => {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      await chrome.storage.session.set({
        redirectLog: { [`${tab.id}:${destination}`]: Date.now() },
      });
      await chrome.storage.local.set({ settings: { ...settings, enabled: false } });
      await chrome.tabs.update(tab.id, { url: destination });
      return tab.id;
    },
    { destination, settings },
  );
  await expect
    .poll(() =>
      extension.worker.evaluate(async (tabId) => {
        const tab = await chrome.tabs.get(tabId);
        return { url: tab.url, status: tab.status };
      }, tabId),
    )
    .toEqual({ url: destination, status: 'complete' });
  await extension.worker.evaluate(() => AWSAutoLogin.setEnabled(true));
  const opened = extension.context.waitForEvent('page');
  await extension.worker.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `${extension.url}/popup/popup.html`,
  );
  const popup = await opened;
  await expect(popup.locator('#detection')).toBeVisible();
  await expect(popup.locator('#accountDisplay')).toContainText('ReadOnly');
  await popup
    .locator('.popup')
    .screenshot({ path: extension.testInfo.outputPath('popup-console.png') });
  await popup.getByRole('button', { name: 'Open in this account' }).click();
  await expect
    .poll(async () =>
      extension.worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://company.awsapps.com/*' });
        return tabs.map((tab) => tab.url);
      }),
    )
    .toContain(
      `https://company.awsapps.com/start/#/console?account_id=123456789012&role_name=ReadOnly&destination=${encodeURIComponent(destination)}`,
    );
});

test('large account lists stay within the popup and remain searchable', async ({ extension }) => {
  await extension.worker.evaluate(
    (settings) =>
      chrome.storage.local.set({
        settings: {
          ...settings,
          accountMappings: Array.from({ length: 80 }, (_, i) => ({
            accountId: String(100000000000 + i),
            label: `Team account ${i + 1}`,
            keyword: '',
          })),
        },
      }),
    settings,
  );
  const page = await openPage(extension, 'popup/popup.html');
  await expect(page.locator('.btn-account')).toHaveCount(80);
  expect((await page.locator('.popup').boundingBox()).height).toBeLessThanOrEqual(600);
  await page.getByRole('searchbox').fill('Team account 80');
  await expect(page.locator('.btn-account')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport();
});

for (const [layout, body] of [
  [
    'nested account names',
    `<main data-testid="account-list">
    <section data-testid="account-list-cell"><div><span data-testid="account-name">Artlist Production</span></div><div><span>Account ID</span><span>123456789012</span><span> | </span><span>prod@example.com</span></div><h3>Permission sets</h3><button>Developer</button></section>
    <section data-testid="account-list-cell"><div><span data-testid="account-name">Finance &amp; Ops</span></div><div><span>Account ID</span><span>210987654321</span></div><h3>Permission sets</h3><button>ReadOnly</button></section>
  </main>`,
  ],
  [
    'plain account rows',
    `<main>
    <button aria-expanded="false"><span>Artlist Production</span><span><b>Account ID: </b>123456789012 | prod@example.com</span></button>
    <button aria-expanded="false"><span>Finance &amp; Ops</span><span><b>Account ID: </b>210987654321 | finance@example.com</span></button>
  </main>`,
  ],
  [
    'embedded account metadata',
    `<main><div class="account">123456789012</div><div class="account">210987654321</div></main>
    <script type="application/json">{"accounts":[{"accountId":"123456789012","accountName":"Artlist Production"},{"accountId":"210987654321","accountName":"Finance & Ops"}]}</script>`,
  ],
]) {
  test(`portal scraper imports names from ${layout}`, async ({ extension }) => {
    await extension.context.route('https://company.awsapps.com/start/', (route) =>
      route.fulfill({ contentType: 'text/html', body }),
    );
    const portal = await extension.context.newPage();
    await portal.goto('https://company.awsapps.com/start/');
    await expect
      .poll(async () =>
        extension.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: 'https://company.awsapps.com/start/' });
          const response = await chrome.tabs
            .sendMessage(tab.id, { type: 'SCRAPE_PORTAL_ACCOUNTS' })
            .catch(() => ({ accounts: [] }));
          return response.accounts.sort((a, b) => a.accountId.localeCompare(b.accountId));
        }),
      )
      .toEqual([
        { accountId: '123456789012', label: 'Artlist Production' },
        { accountId: '210987654321', label: 'Finance & Ops' },
      ]);
  });
}

test('portal import saves and refreshes names, and keeps custom mapping labels', async ({
  extension,
}) => {
  await extension.worker.evaluate(
    (settings) =>
      chrome.storage.local.set({
        settings: {
          ...settings,
          accountMappings: [
            { accountId: '123456789012', keyword: 'prod', label: '' },
            { accountId: '210987654321', keyword: 'dev', label: 'My development account' },
          ],
        },
        learnedAccounts: {
          123456789012: {
            accountId: '123456789012',
            label: 'Old production name',
            services: ['sqs'],
            regions: [],
            resourcePatterns: [],
          },
        },
      }),
    settings,
  );
  await extension.context.route('https://company.awsapps.com/start/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<main><section><span data-testid="account-name">Artlist Production</span><p>Account ID: <span>123456789012</span></p></section><section><span data-testid="account-name">Finance &amp; Ops</span><p>Account ID: <span>210987654321</span></p></section></main>',
    }),
  );
  const portal = await extension.context.newPage();
  await portal.goto('https://company.awsapps.com/start/');
  const options = await openPage(extension, 'options/options.html');
  await options.getByRole('button', { name: 'Import from Portal' }).click();
  await expect(options.locator('#importStatus')).toHaveText(
    'Imported 2 accounts. Save Settings to keep them.',
  );
  await expect(options.getByLabel('Account name', { exact: true }).first()).toHaveValue(
    'Artlist Production',
  );
  await expect(options.getByLabel('Account name', { exact: true }).nth(1)).toHaveValue(
    'My development account',
  );
  await portal
    .locator('[data-testid="account-name"]')
    .first()
    .evaluate((element) => {
      element.textContent = 'Artlist Production EU';
    });
  await options.getByRole('button', { name: 'Import from Portal' }).click();
  await expect(options.getByLabel('Account name', { exact: true }).first()).toHaveValue(
    'Artlist Production EU',
  );
  await options.getByRole('button', { name: 'Save Settings' }).click();
  await expect(options.locator('#saveStatus')).toHaveText('Settings saved');
  const learned = await extension.worker.evaluate(
    async () => (await chrome.storage.local.get('learnedAccounts')).learnedAccounts,
  );
  expect(learned['123456789012'].services).toEqual(['sqs']);
  const popup = await openPage(extension, 'popup/popup.html');
  await expect(popup.getByRole('button', { name: /Artlist Production EU/ })).toBeVisible();
  await expect(popup.getByRole('button', { name: /My development account/ })).toBeVisible();
  await popup
    .locator('.popup')
    .screenshot({ path: extension.testInfo.outputPath('portal-account-names.png') });
});

test('popup has one scroll area and a compact search field with eight accounts', async ({
  extension,
}) => {
  await extension.worker.evaluate(
    (settings) =>
      chrome.storage.local.set({
        settings: {
          ...settings,
          accountMappings: Array.from({ length: 8 }, (_, i) => ({
            accountId: String(100000000000 + i),
            label: `Company account ${i + 1}`,
            keyword: '',
          })),
        },
      }),
    settings,
  );
  const page = await openPage(extension, 'popup/popup.html');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.btn-account')).toHaveCount(8);
  const layout = await page.evaluate(() => ({
    scrolling: [...document.querySelectorAll('*')]
      .filter((element) => {
        const { overflowY } = getComputedStyle(element);
        return (
          ['auto', 'scroll'].includes(overflowY) && element.scrollHeight > element.clientHeight
        );
      })
      .map((element) => element.id || element.tagName.toLowerCase()),
    searchHeight: document.getElementById('accountSearch').getBoundingClientRect().height,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  expect(layout.scrolling).toEqual(['main']);
  expect(layout.searchHeight).toBeLessThanOrEqual(34);
  expect(layout.horizontalOverflow).toBe(false);
  await page
    .locator('.popup')
    .screenshot({ path: extension.testInfo.outputPath('popup-single-scroll.png') });
  await page.locator('.btn-account').last().scrollIntoViewIfNeeded();
  await expect(page.getByRole('searchbox')).toBeInViewport();
  const headerCoverage = await page.evaluate(() => {
    const viewport = document.querySelector('main').getBoundingClientRect();
    const header = document.querySelector('.account-tools').getBoundingClientRect();
    return { top: header.top - viewport.top, left: header.left - viewport.left };
  });
  expect(headerCoverage).toEqual({ top: 0, left: 0 });
  await page
    .locator('.popup')
    .screenshot({ path: extension.testInfo.outputPath('popup-scrolled.png') });
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport();
  await page.getByText('Use another account ID').click();
  await page.getByLabel('AWS account ID', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('AWS account ID', { exact: true })).toBeInViewport();
});

test('drag handles reorder accounts, retain edits, and save the popup order', async ({
  extension,
}) => {
  const page = await openPage(extension, 'options/options.html');
  const rows = page.locator('#mappingsBody tr');
  await expect(rows).toHaveCount(3);
  await rows.first().getByLabel('Account name', { exact: true }).fill('Production edited');
  const target = await rows.last().boundingBox();
  await rows
    .first()
    .getByRole('button', { name: 'Reorder account', exact: true })
    .dragTo(rows.last(), { targetPosition: { x: 80, y: target.height - 2 } });
  await expect(rows.last().getByLabel('Account name', { exact: true })).toHaveValue(
    'Production edited',
  );
  await expect(page.locator('#saveStatus')).toHaveText('Unsaved changes');
  await rows.first().getByRole('button', { name: 'Reorder account', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(rows.first().getByLabel('URL keyword (optional)', { exact: true })).toHaveValue(
    'live',
  );
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Settings saved');
  const saved = await extension.worker.evaluate(
    async () => (await chrome.storage.local.get('settings')).settings,
  );
  expect(saved.accountMappings.map((account) => account.keyword)).toEqual(['live', 'dev', 'prod']);
  expect(saved.accountMappings[2].roleName).toBe('ReadOnly');
  await page.reload();
  await expect(rows.first().getByLabel('URL keyword (optional)', { exact: true })).toHaveValue(
    'live',
  );
  await expect(rows.last().getByLabel('Account name', { exact: true })).toHaveValue(
    'Production edited',
  );
  await page
    .locator('#mappingsTable')
    .screenshot({ path: extension.testInfo.outputPath('mapping-order.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page
    .locator('#mappingsTable')
    .screenshot({ path: extension.testInfo.outputPath('mapping-order-dark.png') });
  const popup = await openPage(extension, 'popup/popup.html');
  await expect(popup.locator('.account-label')).toHaveText(['Production', 'Development']);
});

test('drag handles track added and removed accounts', async ({ extension }) => {
  const page = await openPage(extension, 'options/options.html');
  const rows = page.locator('#mappingsBody tr');
  await expect(rows).toHaveCount(3);
  await page.getByRole('button', { name: '+ Add account' }).click();
  await expect(rows).toHaveCount(4);
  await expect(
    rows.last().getByRole('button', { name: 'Reorder account', exact: true }),
  ).toBeEnabled();
  for (let count = 4; count > 1; count--) {
    await rows.first().getByRole('button', { name: 'Remove account', exact: true }).click();
    await expect(rows).toHaveCount(count - 1);
  }
  await expect(
    rows.first().getByRole('button', { name: 'Reorder account', exact: true }),
  ).toBeDisabled();
});

test('legacy discovered accounts appear in Accounts and stay removed after saving', async ({
  extension,
}) => {
  await extension.worker.evaluate(
    (settings) =>
      chrome.storage.local.set({
        settings: { ...settings, accountMappings: [settings.accountMappings[0]] },
        learnedAccounts: {
          210987654321: { accountId: '210987654321', label: 'Imported development' },
        },
      }),
    settings,
  );
  const page = await openPage(extension, 'options/options.html');
  const rows = page.locator('#mappingsBody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.last().getByLabel('Account name', { exact: true })).toHaveValue(
    'Imported development',
  );
  await rows.last().getByRole('button', { name: 'Remove account' }).click();
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Settings saved');
  await page.reload();
  await expect(rows).toHaveCount(1);
  const popup = await openPage(extension, 'popup/popup.html');
  await expect(popup.locator('.account-label')).toHaveText(['Production']);
});

test('portal imports go into Accounts without overwriting unsaved fields or creating duplicates', async ({
  extension,
}) => {
  await extension.worker.evaluate(
    (settings) => chrome.storage.local.set({ settings: { ...settings, accountMappings: [] } }),
    settings,
  );
  const portal = await extension.context.newPage();
  await portal.goto('https://company.awsapps.com/start/');
  const page = await openPage(extension, 'options/options.html');
  await page.getByRole('button', { name: '+ Add account' }).click();
  await page.getByLabel('AWS account ID', { exact: true }).fill('333333333333');
  await page.getByLabel('Account name', { exact: true }).fill('My custom account');
  await page.getByLabel('Default Role Name', { exact: true }).fill('ReadOnly');
  await page.getByRole('button', { name: 'Import from Portal' }).click();
  await expect(page.locator('#importStatus')).toHaveText(
    'Imported 2 accounts. Save Settings to keep them.',
  );
  await expect(page.locator('#mappingsBody tr')).toHaveCount(3);
  await expect(page.getByLabel('Account name', { exact: true }).first()).toHaveValue(
    'My custom account',
  );
  await expect(page.getByLabel('Default Role Name', { exact: true })).toHaveValue('ReadOnly');
  await expect(page.getByLabel('URL keyword (optional)', { exact: true }).nth(1)).toHaveValue('');
  await page.getByRole('button', { name: 'Import from Portal' }).click();
  await expect(page.locator('#importStatus')).toHaveText(
    'Imported 2 accounts. Save Settings to keep them.',
  );
  await expect(page.locator('#mappingsBody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Settings saved');
  await page.reload();
  await expect(page.locator('#mappingsBody tr')).toHaveCount(3);
  await page.setViewportSize({ width: 1000, height: 1400 });
  await page.screenshot({
    path: extension.testInfo.outputPath('unified-accounts.png'),
    fullPage: true,
  });
});

test('cancelling a drag keeps the original account order', async ({ extension }) => {
  const page = await openPage(extension, 'options/options.html');
  const rows = page.locator('#mappingsBody tr');
  await expect(rows).toHaveCount(3);
  const source = await rows.first().getByRole('button', { name: 'Reorder account' }).boundingBox();
  const target = await rows.last().boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width + 5, source.y + source.height / 2, { steps: 4 });
  await page.mouse.move(target.x + 80, target.y + target.height - 2, { steps: 8 });
  await expect(rows.last().getByLabel('URL keyword (optional)', { exact: true })).toHaveValue(
    'prod',
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(rows.first().getByLabel('URL keyword (optional)', { exact: true })).toHaveValue(
    'prod',
  );
  await expect(page.locator('#saveStatus')).toHaveText('');
});

test('popup shows the signed-in account, not the account in the link', async ({ extension }) => {
  await extension.context.route('https://console.aws.amazon.com/s3/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<meta name="awsc-session-data" content='{ "accountId": "210987654321", "accountAlias": "development" }'><h1>Console</h1>`,
    }),
  );
  await extension.worker.evaluate(() => AWSAutoLogin.setEnabled(false));
  const page = await extension.context.newPage();
  await page.goto('https://console.aws.amazon.com/s3/?account=123456789012');
  await extension.worker.evaluate(() => AWSAutoLogin.setEnabled(true));
  const opened = extension.context.waitForEvent('page');
  await extension.worker.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `${extension.url}/popup/popup.html`,
  );
  const popup = await opened;
  await expect(popup.locator('#currentAccountName')).toHaveText('Development');
  await expect(popup.locator('#currentAccountId')).toHaveText('210987654321');
  await expect(popup.locator('#accountDisplay')).toContainText('123456789012');
  await expect(popup.locator('.btn-account').filter({ hasText: 'Development' })).toContainText(
    'Current',
  );
});

test('popup reads the current account from the AWS account details menu', async ({ extension }) => {
  await extension.context.route('https://console.aws.amazon.com/s3/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div data-testid="account-detail-menu"><span>Account ID</span><span>2109-8765-4321</span></div><h1>Console</h1>',
    }),
  );
  await extension.worker.evaluate(() => AWSAutoLogin.setEnabled(false));
  const page = await extension.context.newPage();
  await page.goto('https://console.aws.amazon.com/s3/');
  await extension.worker.evaluate(() => AWSAutoLogin.setEnabled(true));
  const opened = extension.context.waitForEvent('page');
  await extension.worker.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `${extension.url}/popup/popup.html`,
  );
  const popup = await opened;
  await expect(popup.locator('#currentAccountName')).toHaveText('Development');
  await expect(popup.locator('#currentAccountId')).toHaveText('210987654321');
});

test('popup shows a matching account name when AWS only exposes its navigation label', async ({
  extension,
}) => {
  await extension.context.route('https://console.aws.amazon.com/s3/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button data-testid="awsc-nav-account-menu-button">Development</button><h1>Console</h1>',
    }),
  );
  await extension.worker.evaluate(() => AWSAutoLogin.setEnabled(false));
  const page = await extension.context.newPage();
  await page.goto('https://console.aws.amazon.com/s3/');
  await extension.worker.evaluate(() => AWSAutoLogin.setEnabled(true));
  const opened = extension.context.waitForEvent('page');
  await extension.worker.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `${extension.url}/popup/popup.html`,
  );
  const popup = await opened;
  await expect(popup.locator('#currentAccountName')).toHaveText('Development');
  await expect(popup.locator('#currentAccountId')).toHaveText('Account ID unavailable');
  await page.locator('[data-testid="awsc-nav-account-menu-button"]').evaluate((node) => {
    node.textContent = 'some-user';
  });
  await popup.reload();
  await expect(popup.locator('#currentAccountName')).toHaveText('Account unavailable');
});
