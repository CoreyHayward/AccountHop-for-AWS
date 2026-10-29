self.AWSAutoLogin = self.AWSAutoLogin || {};

let accountUpdates = Promise.resolve();

AWSAutoLogin.updateAccountData = function (update) {
  const result = accountUpdates.then(async () => {
    const stored = await chrome.storage.local.get(['settings', 'learnedAccounts']);
    const settings = { ...AWSAutoLogin.DEFAULT_SETTINGS, ...stored.settings };
    if (!Array.isArray(settings.accountMappings)) settings.accountMappings = [];
    const learnedAccounts = Object.fromEntries(
      Object.entries(stored.learnedAccounts || {})
        .filter(([id, entry]) => AWSAutoLogin.isValidAccountId(id) && entry?.accountId === id)
        .map(([id, entry]) => [
          id,
          {
            ...entry,
            services: Array.isArray(entry.services) ? entry.services : [],
            regions: Array.isArray(entry.regions) ? entry.regions : [],
            resourcePatterns: Array.isArray(entry.resourcePatterns) ? entry.resourcePatterns : [],
          },
        ]),
    );
    const migrated = settings.accountListVersion !== 1;
    if (migrated) {
      settings.accountMappings = AWSAutoLogin.mergeImportedAccounts(
        settings.accountMappings,
        Object.values(learnedAccounts).map((entry) => ({
          accountId: entry.accountId,
          label: entry.label,
        })),
      );
      settings.accountListVersion = 1;
    }
    const outcome = await update({ settings, learnedAccounts });
    if (migrated || outcome.changed) await chrome.storage.local.set({ settings, learnedAccounts });
    return outcome.value;
  });
  accountUpdates = result.catch(() => {});
  return result;
};

AWSAutoLogin.getAccountData = function () {
  return AWSAutoLogin.updateAccountData((data) => ({ changed: false, value: data }));
};

AWSAutoLogin.getSettings = async function () {
  return (await AWSAutoLogin.getAccountData()).settings;
};

AWSAutoLogin.saveSettings = function (next, originalAccountIds = []) {
  return AWSAutoLogin.updateAccountData(({ settings, learnedAccounts }) => {
    const previousIds = new Set(originalAccountIds);
    const nextIds = new Set(next.accountMappings.map((mapping) => mapping.accountId));
    const concurrentAccounts = settings.accountMappings.filter(
      (mapping) => !previousIds.has(mapping.accountId) && !nextIds.has(mapping.accountId),
    );
    for (const id of previousIds) {
      if (!nextIds.has(id)) delete learnedAccounts[id];
    }
    for (const mapping of next.accountMappings) {
      if (learnedAccounts[mapping.accountId] && mapping.label)
        learnedAccounts[mapping.accountId].label = mapping.label;
    }
    Object.assign(settings, next, {
      accountListVersion: 1,
      accountMappings: [...next.accountMappings, ...concurrentAccounts],
    });
    return { changed: true, value: settings };
  });
};

AWSAutoLogin.setEnabled = function (enabled) {
  return AWSAutoLogin.updateAccountData(({ settings }) => {
    settings.enabled = enabled;
    return { changed: true, value: settings };
  });
};

AWSAutoLogin.getRedirectLog = async function () {
  return (await chrome.storage.session.get('redirectLog')).redirectLog || {};
};

AWSAutoLogin.saveRedirectLog = async function (log) {
  await chrome.storage.session.set({ redirectLog: log });
};

AWSAutoLogin.learnAccount = async function (accountId, urlString) {
  if (!AWSAutoLogin.isValidAccountId(accountId)) return;
  return AWSAutoLogin.updateAccountData(({ settings, learnedAccounts }) => {
    const context = AWSAutoLogin.parseUrlContext(urlString);
    const existing = learnedAccounts[accountId] || {
      accountId,
      label: '',
      lastSeen: 0,
      services: [],
      regions: [],
      resourcePatterns: [],
    };
    let changed = Date.now() - existing.lastSeen >= 60000;
    if (changed) existing.lastSeen = Date.now();
    for (const [field, value] of [
      ['services', context.service],
      ['regions', context.region],
      ['resourcePatterns', context.resourcePattern],
    ]) {
      if (value && !existing[field].includes(value)) {
        existing[field].push(value);
        changed = true;
      }
    }
    existing.resourcePatterns = existing.resourcePatterns.slice(-20);
    learnedAccounts[accountId] = existing;
    if (!settings.accountMappings.some((mapping) => mapping.accountId === accountId)) {
      settings.accountMappings.push({
        keyword: '',
        accountId,
        label: existing.label || '',
        roleName: '',
      });
      changed = true;
    }
    return { changed };
  });
};
