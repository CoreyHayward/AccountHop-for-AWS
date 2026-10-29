const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const id = '123456789012';
const url = `https://console.aws.amazon.com/sqs/?account=${id}#/queues/test`;
const settings = {
  enabled: true,
  portalUrl: 'company.awsapps.com',
  roleName: 'Developer',
  accountMappings: [{ keyword: '', accountId: id, roleName: 'Read Only' }],
};
const harness = (options = {}) => load({ worker: true, settings, ...options });
const redirect = (h, overrides = {}, sender = {}) =>
  h.message({ type: 'REDIRECT_WITH_ACCOUNT', tabId: 1, url, accountId: id, ...overrides }, sender);

test('automatic redirect encodes destination and honors account role', async () => {
  const h = harness();
  await h.navigate(url);
  assert.equal(h.navigations.length, 1);
  const portal = new URL(h.navigations[0].url);
  const params = new URLSearchParams(portal.hash.split('?')[1]);
  assert.equal(params.get('role_name'), 'Read Only');
  assert.equal(params.get('destination'), url);
});
test('SSO return and repeated loads keep their loop guard', async () => {
  const h = harness();
  await h.navigate(url);
  await h.navigate(url);
  await h.navigate(url);
  assert.equal(h.navigations.length, 1);
  const result = await h.message({ type: 'WAS_RECENTLY_REDIRECTED' }, { tab: { id: 1, url } });
  assert.equal(result.wasRedirected, true);
});
test('guard survives worker restart and applies only to its tab and resource', async () => {
  const first = harness();
  await first.navigate(url);
  const h = harness({ session: first.sessionData });
  await h.navigate(url);
  assert.equal(h.navigations.length, 0);
  await h.navigate(url, 2);
  await h.navigate(url.replace('test', 'another'), 1);
  assert.equal(h.navigations.length, 2);
});
test('manual switch can retry during the automatic loop guard', async () => {
  const h = harness();
  await h.navigate(url);
  assert.equal((await redirect(h)).success, true);
  assert.equal(h.navigations.length, 2);
});
test('navigation failure returns an error and removes its guard', async () => {
  const h = harness({ updateError: 'Tab was closed' });
  assert.equal((await redirect(h)).error, 'Tab was closed');
  assert.equal(Object.keys(h.sessionData.redirectLog).length, 0);
});
test('disabled and unconfigured extensions reject manual redirects and hide the banner', async () => {
  for (const config of [
    { ...settings, enabled: false },
    { ...settings, portalUrl: 'evil.test' },
  ]) {
    const h = harness({ settings: config });
    assert.equal((await redirect(h)).success, false);
    assert.equal(
      (await h.message({ type: 'SHOW_CHOOSER' }, { tab: { id: 1, url } })).available,
      false,
    );
    await h.navigate(url);
    assert.equal(h.navigations.length, 0);
  }
});
test('rejects invalid destinations and account IDs', async () => {
  const h = harness();
  for (const overrides of [
    { url: 'https://example.com/' },
    { accountId: '123' },
    { tabId: null },
  ]) {
    assert.equal((await redirect(h, overrides)).success, false);
  }
  assert.equal(h.navigations.length, 0);
});
test('content script can only redirect its own tab', async () => {
  const h = harness();
  await redirect(h, { tabId: 5 }, { tab: { id: 0 } });
  assert.equal(h.navigations[0].tabId, 0);
});
test('new-tab switch records guard before opening portal and leaves the source tab alone', async () => {
  const h = harness();
  await redirect(h, { newTab: true });
  assert.equal(h.created.length, 1);
  assert.equal(h.navigations[0].tabId, h.created[0].id);
  await h.navigate(url, h.created[0].id);
  assert.equal(h.navigations.length, 1);
});
test('ambiguous links prompt even when default fallback is set', async () => {
  const h = harness({
    settings: { ...settings, fallbackBehavior: 'default', defaultAccountId: id },
  });
  const ambiguous = url + '/210987654321/';
  await h.navigate(ambiguous);
  assert.equal(h.navigations.length, 0);
  const restarted = harness({ settings, session: h.sessionData });
  const result = await restarted.message(
    { type: 'SHOW_CHOOSER' },
    { tab: { id: 1, url: ambiguous } },
  );
  assert.equal(result.pending.detection.matchSource, 'ambiguous');
});
test('stale prompts from earlier pages never appear on a new page', async () => {
  const h = harness({
    session: { 'pendingPrompt:1': { originalUrl: 'https://console.aws.amazon.com/old' } },
  });
  const result = await h.message({ type: 'SHOW_CHOOSER' }, { tab: { id: 1, url } });
  assert.equal(result.pending, null);
});
test('default fallback asks about conflicting roles regardless of mapping order', async () => {
  const mappings = [
    { accountId: id, roleName: 'ReadOnly' },
    { accountId: id, roleName: 'Admin' },
  ];
  const destination = 'https://console.aws.amazon.com/s3/';
  for (const accountMappings of [mappings, [...mappings].reverse()]) {
    const h = harness({
      settings: { ...settings, accountMappings, fallbackBehavior: 'default', defaultAccountId: id },
    });
    await h.navigate(destination);
    assert.equal(h.navigations.length, 0);
    const response = await h.message(
      { type: 'SHOW_CHOOSER' },
      { tab: { id: 1, url: destination } },
    );
    assert.equal(response.pending.detection.matchSource, 'ambiguous');
  }
});

test('default fallback keeps an unambiguous role override after reordering', async () => {
  const destination = 'https://console.aws.amazon.com/s3/';
  const mappings = [
    { accountId: '210987654321', roleName: 'Admin' },
    { accountId: id, roleName: 'ReadOnly' },
  ];
  for (const accountMappings of [mappings, [...mappings].reverse()]) {
    const h = harness({
      settings: { ...settings, accountMappings, fallbackBehavior: 'default', defaultAccountId: id },
    });
    await h.navigate(destination);
    const params = new URLSearchParams(new URL(h.navigations[0].url).hash.split('?')[1]);
    assert.equal(params.get('role_name'), 'ReadOnly');
  }
});
