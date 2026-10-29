const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const id = '123456789012';
const other = '210987654321';
const clean = (value) => JSON.parse(JSON.stringify(value));

test('portal import adds accounts directly with names and no automatic keyword rules', () => {
  const { api } = load();
  const result = api.mergeImportedAccounts(
    [],
    [
      { accountId: id, label: 'Production' },
      { accountId: id, label: 'Production' },
      { accountId: other, label: 'Development' },
      { accountId: 'bad', label: 'Invalid' },
      null,
    ],
  );
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((account) => account.keyword),
    ['', ''],
  );
  assert.equal(result[0].label, 'Production');
});

test('reimport keeps order, custom names, keywords, and distinct roles', () => {
  const { api } = load();
  const accounts = [
    { accountId: id, label: 'My production', keyword: 'prod', roleName: 'ReadOnly' },
    { accountId: id, label: 'My production admin', keyword: 'admin', roleName: 'Admin' },
  ];
  const result = api.mergeImportedAccounts(accounts, [
    { accountId: id, label: 'Portal Production' },
    { accountId: other, label: 'Development' },
  ]);
  assert.deepEqual(
    result.slice(0, 2).map((account) => account.label),
    ['My production', 'My production admin'],
  );
  assert.deepEqual(
    result.slice(0, 2).map((account) => account.roleName),
    ['ReadOnly', 'Admin'],
  );
  assert.equal(result[0].keyword, 'prod');
  assert.equal(result[2].accountId, other);
  assert.equal(accounts[0].portalName, undefined);
});

test('reimport refreshes portal names and fills blanks while retaining edited names', () => {
  const { api } = load();
  const imported = api.mergeImportedAccounts([], [{ accountId: id, label: 'Old name' }]);
  assert.equal(
    api.mergeImportedAccounts(imported, [{ accountId: id, label: 'New name' }])[0].label,
    'New name',
  );
  imported[0].label = 'Custom';
  assert.equal(
    api.mergeImportedAccounts(imported, [{ accountId: id, label: 'New name' }])[0].label,
    'Custom',
  );
  imported[0].label = '';
  assert.equal(
    api.mergeImportedAccounts(imported, [{ accountId: id, label: 'New name' }])[0].label,
    'New name',
  );
});

test('legacy discovered accounts migrate once into the account list with existing overrides intact', async () => {
  const h = load({
    settings: {
      roleName: 'Developer',
      accountMappings: [{ accountId: id, label: 'Custom', keyword: 'prod', roleName: 'ReadOnly' }],
    },
    learnedAccounts: {
      [id]: { accountId: id, label: 'Portal production' },
      [other]: { accountId: other, label: 'Development' },
    },
  });
  const settings = await h.api.getSettings();
  assert.deepEqual(clean(settings.accountMappings.map((account) => account.accountId)), [
    id,
    other,
  ]);
  assert.equal(settings.accountMappings[0].label, 'Custom');
  assert.equal(settings.accountMappings[0].roleName, 'ReadOnly');
  assert.equal(settings.accountMappings[1].label, 'Development');
  assert.equal(settings.accountMappings[1].keyword, '');
  const writes = h.writes.length;
  await h.api.getSettings();
  assert.equal(h.writes.length, writes);
});

test('removing an account does not restore it from old discovery data', async () => {
  const h = load({ learnedAccounts: { [id]: { accountId: id, label: 'Production' } } });
  const settings = await h.api.getSettings();
  await h.api.saveSettings({ ...settings, accountMappings: [] }, [id]);
  assert.equal((await h.api.getSettings()).accountMappings.length, 0);
  assert.equal(h.localData.learnedAccounts[id], undefined);
});

test('saving draft accounts preserves accounts discovered since the settings page opened', async () => {
  const h = load({ settings: { accountMappings: [{ accountId: id, label: 'Production' }] } });
  const draft = await h.api.getSettings();
  await h.api.learnAccount(other, 'https://console.aws.amazon.com/sqs/');
  await h.api.saveSettings(
    { ...draft, accountMappings: [{ ...draft.accountMappings[0], label: 'Renamed' }] },
    [id],
  );
  assert.deepEqual(
    h.localData.settings.accountMappings.map((account) => account.accountId),
    [id, other],
  );
  assert.equal(h.localData.settings.accountMappings[0].label, 'Renamed');
});

test('switching learns context and adds a missing account directly to the list', async () => {
  const h = load();
  await h.api.learnAccount(id, 'https://eu-central-1.console.aws.amazon.com/sqs/');
  assert.equal(h.localData.settings.accountMappings[0].accountId, id);
  assert.equal(h.localData.settings.accountMappings[0].keyword, '');
  assert.deepEqual(h.localData.learnedAccounts[id].services, ['sqs']);
});
