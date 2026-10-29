importScripts('../shared/constants.js', '../shared/storage.js', '../shared/account-detector.js');

const {
  MESSAGES,
  LOOP_TTL_MS,
  isAwsConsoleUrl,
  isValidAccountId,
  isConfigured,
  normalizePortalUrl,
  detectAccount,
  getSettings,
  getRedirectLog,
  saveRedirectLog,
  getAccountData,
  saveSettings,
  setEnabled,
  learnAccount,
} = AWSAutoLogin;

let redirectLog = {};
const latestNavigations = new Map();
const hydratedPromise = getRedirectLog().then((log) => {
  redirectLog = log;
});

function normalizeUrl(urlString) {
  const url = new URL(urlString);
  for (const key of ['sessionId', 'token', 'X-Amz-Security-Token']) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

function loopKey(tabId, url) {
  return `${tabId}:${normalizeUrl(url)}`;
}

function wasRecentlyRedirected(tabId, url) {
  const timestamp = redirectLog[loopKey(tabId, url)];
  return !!timestamp && Date.now() - timestamp < LOOP_TTL_MS;
}

async function recordRedirect(tabId, url) {
  const cutoff = Date.now() - LOOP_TTL_MS;
  for (const key of Object.keys(redirectLog)) {
    if (redirectLog[key] < cutoff) delete redirectLog[key];
  }
  redirectLog[loopKey(tabId, url)] = Date.now();
  await saveRedirectLog(redirectLog);
}

function promptKey(tabId) {
  return `pendingPrompt:${tabId}`;
}

function buildPortalUrl(settings, accountId, destination, roleOverride) {
  return (
    `https://${normalizePortalUrl(settings.portalUrl)}/start/#/console?account_id=${accountId}` +
    `&role_name=${encodeURIComponent(roleOverride || settings.roleName)}` +
    `&destination=${encodeURIComponent(destination)}`
  );
}

async function redirectTab(settings, tabId, url, accountId, roleName) {
  await recordRedirect(tabId, url);
  try {
    await chrome.tabs.update(tabId, { url: buildPortalUrl(settings, accountId, url, roleName) });
  } catch (error) {
    delete redirectLog[loopKey(tabId, url)];
    await saveRedirectLog(redirectLog);
    throw error;
  }
  await learnAccount(accountId, url).catch((error) =>
    console.error('[AccountHop] Could not remember account:', error),
  );
}

async function handleNavigation({ url, tabId, frameId }) {
  if (frameId !== 0) return;
  latestNavigations.set(tabId, url);
  await chrome.storage.session.remove(promptKey(tabId));
  if (!isAwsConsoleUrl(url)) return;
  await hydratedPromise;
  const { settings, learnedAccounts } = await getAccountData();
  if (!settings.enabled || !isConfigured(settings) || wasRecentlyRedirected(tabId, url)) return;
  if (latestNavigations.get(tabId) !== url) return;
  const detection = detectAccount(url, settings.accountMappings, learnedAccounts);
  const shouldRedirect =
    detection.confidence === 'high' ||
    (detection.confidence === 'medium' && settings.autoRedirectMinConfidence !== 'high');
  if (detection.accountId && shouldRedirect) {
    await redirectTab(settings, tabId, url, detection.accountId, detection.roleName);
  } else if (
    detection.matchSource === 'ambiguous' ||
    detection.confidence === 'medium' ||
    settings.fallbackBehavior === 'prompt'
  ) {
    await chrome.storage.session.set({ [promptKey(tabId)]: { detection, originalUrl: url } });
  } else if (
    settings.fallbackBehavior === 'default' &&
    isValidAccountId(settings.defaultAccountId)
  ) {
    const roles = new Set(
      settings.accountMappings
        .filter((mapping) => mapping.accountId === settings.defaultAccountId)
        .map((mapping) => mapping.roleName || settings.roleName),
    );
    if (roles.size > 1) {
      await chrome.storage.session.set({
        [promptKey(tabId)]: {
          detection: { accountId: null, confidence: 'low', matchSource: 'ambiguous', label: null },
          originalUrl: url,
        },
      });
      return;
    }
    await redirectTab(settings, tabId, url, settings.defaultAccountId, [...roles][0]);
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    return handleNavigation(details).catch((error) =>
      console.error('[AccountHop] Navigation failed:', error),
    );
  },
  { url: [{ hostEquals: 'console.aws.amazon.com' }, { hostSuffix: '.console.aws.amazon.com' }] },
);

async function handleGetDetection(message) {
  const { settings, learnedAccounts } = await getAccountData();
  return {
    detection: detectAccount(message.url, settings.accountMappings, learnedAccounts),
    settings,
  };
}

async function handleRedirectWithAccount(message, sender) {
  await hydratedPromise;
  const settings = await getSettings();
  if (!settings.enabled || !isConfigured(settings))
    throw new Error('Open Settings and enable AccountHop with a valid portal and role.');
  const { url, accountId, roleName } = message;
  if (!isValidAccountId(accountId) || !isAwsConsoleUrl(url))
    throw new Error('Choose a valid AWS account and console URL.');
  const extensionPage = !sender.tab || sender.url?.startsWith(chrome.runtime.getURL(''));
  if (message.newTab && extensionPage) {
    const tab = await chrome.tabs.create({ url: 'about:blank' });
    await redirectTab(settings, tab.id, url, accountId, roleName);
  } else {
    const tabId = extensionPage ? message.tabId : sender.tab.id;
    if (!Number.isInteger(tabId) || tabId < 0)
      throw new Error('This tab is no longer available. Reopen AccountHop.');
    await redirectTab(settings, tabId, url, accountId, roleName);
    await chrome.storage.session.remove(promptKey(tabId));
  }
  return { success: true };
}

async function handleGetStatus() {
  const settings = await getSettings();
  return {
    enabled: settings.enabled,
    configured: isConfigured(settings),
    portalUrl: settings.portalUrl,
    roleName: settings.roleName,
  };
}

async function handleWasRecentlyRedirected(message, sender) {
  await hydratedPromise;
  const url = sender.url || sender.tab?.url;
  return {
    wasRedirected:
      Number.isInteger(sender.tab?.id) &&
      isAwsConsoleUrl(url) &&
      wasRecentlyRedirected(sender.tab.id, url),
  };
}

async function handleShowChooser(message, sender) {
  const { settings } = await getAccountData();
  const tabId = sender.tab?.id;
  const url = sender.url || sender.tab?.url;
  if (
    !settings.enabled ||
    !isConfigured(settings) ||
    !isAwsConsoleUrl(url) ||
    !Number.isInteger(tabId)
  )
    return { available: false };
  await hydratedPromise;
  if (wasRecentlyRedirected(tabId, url)) return { available: false };
  const key = promptKey(tabId);
  const saved = await chrome.storage.session.get(key);
  const pending = saved[key]?.originalUrl === url ? saved[key] : null;
  await chrome.storage.session.remove(key);
  return {
    available: true,
    pending,
    accountMappings: settings.accountMappings,
    originalUrl: url,
  };
}

const handlers = {
  [MESSAGES.GET_DETECTION]: handleGetDetection,
  [MESSAGES.REDIRECT_WITH_ACCOUNT]: handleRedirectWithAccount,
  [MESSAGES.GET_STATUS]: handleGetStatus,
  [MESSAGES.WAS_RECENTLY_REDIRECTED]: handleWasRecentlyRedirected,
  [MESSAGES.SHOW_CHOOSER]: handleShowChooser,
  [MESSAGES.GET_SETTINGS]: async () => ({ settings: await getSettings() }),
  [MESSAGES.SAVE_SETTINGS]: async (message, sender) => {
    if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')))
      throw new Error('Open Settings to save accounts.');
    const settings = message.settings;
    if (
      !settings ||
      !Array.isArray(settings.accountMappings) ||
      !isConfigured(settings) ||
      settings.accountMappings.some((mapping) => !isValidAccountId(mapping.accountId))
    )
      throw new Error('Check the portal, role, and account IDs.');
    return {
      success: true,
      settings: await saveSettings(settings, message.originalAccountIds || []),
    };
  },
  [MESSAGES.SET_ENABLED]: async (message) => ({ settings: await setEnabled(!!message.enabled) }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!Object.hasOwn(handlers, message?.type)) return;
  Promise.resolve()
    .then(() => handlers[message.type](message, sender))
    .then(sendResponse)
    .catch((error) => {
      console.error(`[AccountHop] ${message.type}:`, error);
      sendResponse({ success: false, error: error.message });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  latestNavigations.delete(tabId);
  Promise.resolve()
    .then(async () => {
      await hydratedPromise;
      for (const key of Object.keys(redirectLog)) {
        if (key.startsWith(tabId + ':')) delete redirectLog[key];
      }
      await Promise.all([
        saveRedirectLog(redirectLog),
        chrome.storage.session.remove(promptKey(tabId)),
      ]);
    })
    .catch((error) => console.error('[AccountHop] Tab cleanup failed:', error));
});
