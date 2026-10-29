const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const { api } = load();
const id = '123456789012';
const other = '210987654321';
const base = 'https://eu-central-1.console.aws.amazon.com/sqs/v3/home';
const mappings = [{ keyword: 'prod', accountId: id, label: 'Production', roleName: 'ReadOnly' }];

for (const [label, suffix] of [
  ['query', `?accountId=${id}`],
  ['hash query', `#/queues?account_id=${id}`],
  ['hash path', `#/queues/${id}/queue`],
  ['encoded ARN', `#${encodeURIComponent(`arn:aws:sqs:eu-central-1:${id}:queue`)}`],
  [
    'embedded service URL',
    `#${encodeURIComponent(`https://sqs.eu-central-1.amazonaws.com/${id}/queue`)}`,
  ],
]) {
  test(`detects an explicit account from ${label} and applies its role`, () => {
    const result = api.detectAccount(base + suffix, mappings);
    assert.equal(result.accountId, id);
    assert.equal(result.confidence, 'high');
    assert.equal(result.roleName, 'ReadOnly');
  });
}

test('handles malformed percent encoding without throwing', () => {
  assert.equal(api.detectAccount(`${base}?account=${id}#bad%escape`, mappings).accountId, id);
});
test('does not choose between conflicting explicit accounts', () => {
  assert.equal(api.detectAccount(`${base}?account=${id}#/${other}/x`).matchSource, 'ambiguous');
});
test('explicit account IDs take priority over keyword mappings', () => {
  assert.equal(api.detectAccount(`${base}?account=${other}#/prod`, mappings).accountId, other);
});
test('matches keywords as whole words', () => {
  assert.equal(api.detectAccount(`${base}#/my-prod-queue`, mappings).accountId, id);
  assert.equal(api.detectAccount(`${base}#/nonprod-queue`, mappings).accountId, null);
  assert.equal(api.detectAccount(`${base}#/production`, mappings).accountId, null);
});
test('does not choose between conflicting keywords or roles', () => {
  assert.equal(
    api.detectAccount(`${base}#/prod-dev`, [...mappings, { keyword: 'dev', accountId: other }])
      .matchSource,
    'ambiguous',
  );
  assert.equal(
    api.detectAccount(`${base}#/prod-admin`, [
      ...mappings,
      { keyword: 'admin', accountId: id, roleName: 'Admin' },
    ]).matchSource,
    'ambiguous',
  );
});
test('rejects invalid account mappings and non-console URLs', () => {
  assert.equal(
    api.detectAccount(`${base}#/prod`, [{ keyword: 'prod', accountId: '123' }]).accountId,
    null,
  );
  for (const url of [
    'invalid',
    `http://console.aws.amazon.com/?account=${id}`,
    `https://console.aws.amazon.com.evil.test/?account=${id}`,
  ]) {
    assert.equal(api.detectAccount(url, mappings).accountId, null);
  }
});
test('learned matches remain suggestions', () => {
  const result = api.detectAccount(base, [], { [id]: { accountId: id, services: ['sqs'] } });
  assert.equal(result.accountId, id);
  assert.equal(result.confidence, 'low');
});
test('parses the region after a service hostname and newer multi-part regions', () => {
  const result = api.parseUrlContext('https://sqs.eu-central-1.console.aws.amazon.com/');
  assert.equal(result.region, 'eu-central-1');
  assert.equal(result.service, 'sqs');
  assert.equal(
    api.parseUrlContext('https://il-central-1.console.aws.amazon.com/s3/').region,
    'il-central-1',
  );
  assert.equal(
    api.parseUrlContext('https://us-isob-east-1.console.aws.amazon.com/s3/').service,
    's3',
  );
});
test('deduplicates accounts while keeping distinct roles', () => {
  const accounts = api.getAccountChoices(
    [...mappings, ...mappings, { accountId: id, roleName: 'Admin' }, { accountId: 'bad' }],
    { [id]: { accountId: id }, [other]: { accountId: other } },
  );
  assert.equal(accounts.length, 2);
  assert.equal(accounts[1].roleName, 'Admin');
  assert.equal(
    accounts.some((account) => account.accountId === other),
    false,
  );
});
for (const portal of [
  'company.awsapps.com',
  'https://company.awsapps.com/start/#/accounts',
  ' COMPANY.awsapps.com/ ',
]) {
  test(`accepts portal ${portal}`, () =>
    assert.equal(api.normalizePortalUrl(portal), 'company.awsapps.com'));
}
for (const portal of [
  'https://company.awsapps.com.evil.test',
  'http://company.awsapps.com',
  'https://user:pass@company.awsapps.com',
  'https://company.awsapps.com:444/start',
  'company.awsapps.com/other',
  '',
  'company.awsapps.com@evil.test',
]) {
  test(`rejects invalid portal ${portal}`, () => assert.equal(api.normalizePortalUrl(portal), ''));
}
test('serializes concurrent learning and avoids repeated writes', async () => {
  const harness = load();
  await Promise.all([harness.api.learnAccount(id, base), harness.api.learnAccount(other, base)]);
  assert.equal(Object.keys(harness.localData.learnedAccounts).length, 2);
  const before = harness.writes.length;
  await harness.api.learnAccount(id, base);
  assert.equal(harness.writes.length, before);
});

test('explicit account with conflicting saved roles asks for a choice unless a keyword resolves it', () => {
  const roles = [...mappings, { keyword: 'admin', accountId: id, roleName: 'Admin' }];
  assert.equal(api.detectAccount(`${base}?account=${id}`, roles).matchSource, 'ambiguous');
  assert.equal(api.detectAccount(`${base}?account=${id}#/prod`, roles).roleName, 'ReadOnly');
});
