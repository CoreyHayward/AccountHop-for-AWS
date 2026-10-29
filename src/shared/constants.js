self.AWSAutoLogin = self.AWSAutoLogin || {};

AWSAutoLogin.CONFIDENCE = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

AWSAutoLogin.ACCOUNT_ID_RE = /^\d{12}$/;

AWSAutoLogin.DEFAULT_SETTINGS = {
  portalUrl: '',
  roleName: '',
  accountMappings: [], // [{ keyword, accountId, label, roleName? }]
  fallbackBehavior: 'prompt', // 'prompt' | 'ignore' | 'default'
  defaultAccountId: '',
  autoRedirectMinConfidence: 'high', // 'high' | 'medium'
  enabled: true,
};

AWSAutoLogin.LOOP_TTL_MS = 5 * 60 * 1000;

AWSAutoLogin.MESSAGES = {
  GET_DETECTION: 'GET_DETECTION',
  GET_CURRENT_ACCOUNT: 'GET_CURRENT_ACCOUNT',
  REDIRECT_WITH_ACCOUNT: 'REDIRECT_WITH_ACCOUNT',
  GET_STATUS: 'GET_STATUS',
  SHOW_CHOOSER: 'SHOW_CHOOSER',
  WAS_RECENTLY_REDIRECTED: 'WAS_RECENTLY_REDIRECTED',
  SCRAPE_PORTAL_ACCOUNTS: 'SCRAPE_PORTAL_ACCOUNTS',
  GET_SETTINGS: 'GET_SETTINGS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  SET_ENABLED: 'SET_ENABLED',
};

// Services that are generic AWS pages, not specific resource views.
AWSAutoLogin.GENERIC_SERVICES = new Set(['console', 'home', 'support', 'billing', 'health']);

AWSAutoLogin.isAwsConsoleUrl = function (urlString) {
  try {
    const { protocol, hostname } = new URL(urlString);
    return (
      protocol === 'https:' &&
      (hostname === 'console.aws.amazon.com' || hostname.endsWith('.console.aws.amazon.com'))
    );
  } catch {
    return false;
  }
};

AWSAutoLogin.isValidAccountId = function (value) {
  return typeof value === 'string' && AWSAutoLogin.ACCOUNT_ID_RE.test(value);
};

AWSAutoLogin.normalizePortalUrl = function (value) {
  try {
    const url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.awsapps\.com$/.test(url.hostname)) return '';
    if (!['', '/', '/start', '/start/'].includes(url.pathname)) return '';
    return url.hostname;
  } catch {
    return '';
  }
};

AWSAutoLogin.isConfigured = function (settings) {
  return !!(AWSAutoLogin.normalizePortalUrl(settings.portalUrl) && settings.roleName?.trim());
};

AWSAutoLogin.safeDecode = function (value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

AWSAutoLogin.escapeHtml = function (str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

AWSAutoLogin.mergeImportedAccounts = function (mappings, accounts) {
  const result = mappings.map((mapping) => ({ ...mapping }));
  for (const account of accounts) {
    if (!account || !AWSAutoLogin.isValidAccountId(account.accountId)) continue;
    const name = typeof account.label === 'string' ? account.label.trim().slice(0, 200) : '';
    const existing = result.filter((mapping) => mapping.accountId === account.accountId);
    if (existing.length) {
      for (const mapping of existing) {
        if (!name) continue;
        if (!mapping.label || mapping.label === mapping.portalName) mapping.label = name;
        mapping.portalName = name;
      }
    } else {
      result.push({
        keyword: '',
        accountId: account.accountId,
        label: name,
        roleName: '',
        portalName: name,
      });
    }
  }
  return result;
};

AWSAutoLogin.getAccountChoices = function (mappings) {
  const seen = new Set();
  return (mappings || [])
    .filter((mapping) => AWSAutoLogin.isValidAccountId(mapping.accountId))
    .map((mapping) => ({
      accountId: mapping.accountId,
      label: mapping.label || mapping.keyword || mapping.accountId,
      roleName: mapping.roleName || null,
    }))
    .filter((account) => {
      const key = `${account.accountId}:${account.roleName || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};
