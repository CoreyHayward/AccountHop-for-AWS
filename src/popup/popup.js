document.addEventListener('DOMContentLoaded', async () => {
  const { MESSAGES, isAwsConsoleUrl, getAccountChoices, normalizePortalUrl, isConfigured } =
    AWSAutoLogin;
  const el = (id) => document.getElementById(id);
  let tab;
  let settings;
  let busy = false;
  let allAccounts = [];

  function showError(error) {
    el('error').textContent =
      error.message || 'AccountHop could not complete that action. Try again.';
    el('error').hidden = false;
  }

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.error)
      throw new Error(response?.error || 'Reload the extension and try again.');
    return response;
  }

  async function openSettings() {
    try {
      await chrome.runtime.openOptionsPage();
      window.close();
    } catch (error) {
      showError(error);
    }
  }
  el('openSettings').addEventListener('click', openSettings);
  el('openSettingsTop').addEventListener('click', openSettings);

  el('enabled').addEventListener('change', async () => {
    el('enabled').disabled = true;
    try {
      const response = await request({
        type: MESSAGES.SET_ENABLED,
        enabled: el('enabled').checked,
      });
      settings = response.settings;
      renderState();
    } catch (error) {
      el('enabled').checked = !el('enabled').checked;
      showError(error);
    } finally {
      el('enabled').disabled = false;
    }
  });

  function renderState() {
    el('notConfigured').hidden = isConfigured(settings);
    el('disabled').hidden = !isConfigured(settings) || settings.enabled;
    el('workspace').hidden = !isConfigured(settings) || !settings.enabled;
    el('enabledLabel').textContent = settings.enabled
      ? 'Automatic switching on'
      : 'AccountHop paused';
  }

  async function switchAccount(account, button) {
    if (busy) return;
    busy = true;
    el('error').hidden = true;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Opening…';
    try {
      const consolePage = isAwsConsoleUrl(tab?.url);
      const response = await request({
        type: MESSAGES.REDIRECT_WITH_ACCOUNT,
        tabId: tab?.id,
        newTab: !consolePage,
        url: consolePage ? tab.url : 'https://console.aws.amazon.com/',
        accountId: account.accountId,
        roleName: account.roleName,
      });
      if (!response.success) throw new Error('Could not open this account. Try again.');
      window.close();
    } catch (error) {
      showError(error);
      button.textContent = label;
      button.disabled = false;
      busy = false;
    }
  }

  function renderAccounts() {
    const query = el('accountSearch').value.trim().toLowerCase();
    const accounts = allAccounts.filter((account) =>
      `${account.label} ${account.accountId} ${account.roleName || settings.roleName}`
        .toLowerCase()
        .includes(query),
    );
    const list = el('accountList');
    list.replaceChildren();
    for (const account of accounts) {
      const button = document.createElement('button');
      button.className = 'btn-account';
      const name = document.createElement('span');
      name.className = 'account-label';
      name.textContent = account.label;
      const info = document.createElement('span');
      info.className = 'account-meta';
      info.textContent = `${account.accountId} · ${account.roleName || settings.roleName}`;
      button.append(name, info);
      button.title = `${account.label} — ${info.textContent}`;
      button.addEventListener('click', () => switchAccount(account, button));
      list.appendChild(button);
    }
    el('emptyAccounts').hidden = accounts.length > 0;
    el('emptyAccounts').textContent = allAccounts.length
      ? 'No accounts match. Try another name or ID.'
      : 'No accounts yet. Import from your portal in Settings, or enter an account ID below.';
    el('accountCount').textContent = String(allAccounts.length);
    el('resultCount').textContent =
      `${accounts.length} account${accounts.length === 1 ? '' : 's'} found`;
  }

  el('accountSearch').addEventListener('input', renderAccounts);
  el('accountSearch').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      const first = el('accountList').querySelector('button');
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  el('manualSwitch').addEventListener('submit', (event) => {
    event.preventDefault();
    switchAccount(
      { accountId: el('manualAccount').value.trim() },
      el('manualSwitch').querySelector('button'),
    );
  });
  el('openPortal').addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ url: `https://${normalizePortalUrl(settings.portalUrl)}/start/` });
      window.close();
    } catch (error) {
      showError(error);
    }
  });

  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await request({ type: MESSAGES.GET_DETECTION, url: tab?.url || '' });
    settings = response.settings;
    allAccounts = getAccountChoices(settings.accountMappings);
    el('enabled').checked = settings.enabled;
    el('enabled').disabled = false;
    renderState();
    el('pageContext').textContent = isAwsConsoleUrl(tab?.url)
      ? 'Switching keeps this console link.'
      : 'Accounts open in a new tab.';
    el('portalDisplay').textContent = settings.portalUrl;
    el('manualRole').textContent = `Uses the ${settings.roleName} role.`;
    const { detection } = response;
    if (detection.accountId) {
      el('detection').hidden = false;
      const suggestion = detection.confidence === 'low';
      el('detectionTitle').textContent = suggestion
        ? 'Suggested account'
        : 'Account found in this link';
      el('labelDisplay').textContent =
        detection.label ||
        allAccounts.find((a) => a.accountId === detection.accountId)?.label ||
        'AWS account';
      el('accountDisplay').textContent =
        `${detection.accountId} · ${detection.roleName || settings.roleName}`;
      el('detectionReason').textContent = suggestion
        ? 'Based on past browsing. Check the account before opening.'
        : detection.matchSource === 'exact-mapping'
          ? 'Matched one of your keyword rules.'
          : 'This link contains the account ID.';
      el('redirectNow').addEventListener('click', () =>
        switchAccount(detection, el('redirectNow')),
      );
    } else if (detection.matchSource === 'ambiguous') {
      el('pageContext').textContent =
        'This link matches more than one account or role. Choose below.';
    }
    renderAccounts();
    if (settings.enabled && isConfigured(settings)) el('accountSearch').focus();
  } catch (error) {
    showError(error);
  } finally {
    el('loading').hidden = true;
  }
});
