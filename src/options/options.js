document.addEventListener('DOMContentLoaded', async () => {
  const { MESSAGES, escapeHtml, isValidAccountId, normalizePortalUrl, mergeImportedAccounts } =
    AWSAutoLogin;
  const el = (id) => document.getElementById(id);
  let settings;
  let originalAccountIds = [];
  let dirty = false;
  let revision = 0;
  let draggedRow = null;
  let orderBeforeDrag = [];
  const mappingsBody = el('mappingsBody');

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.error)
      throw new Error(response?.error || 'Reload AccountHop and try again.');
    return response;
  }

  function status(id, message, state = 'pending') {
    el(id).textContent = message;
    el(id).dataset.state = state;
  }

  function markDirty() {
    dirty = true;
    revision++;
    status('saveStatus', 'Unsaved changes');
  }

  function getRadio(name, fallback) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
  }

  function updateDefaultAccountVisibility() {
    el('defaultAccountField').hidden = getRadio('fallbackBehavior', 'prompt') !== 'default';
  }

  function draftAccounts() {
    return Array.from(mappingsBody.children).map((row) => ({
      keyword: row.querySelector('.mapping-keyword').value.trim(),
      accountId: row.querySelector('.mapping-account').value.trim(),
      label: row.querySelector('.mapping-label').value.trim(),
      roleName: row.querySelector('.mapping-role').value.trim(),
      ...(row.dataset.portalName !== undefined ? { portalName: row.dataset.portalName } : {}),
    }));
  }

  function updateMappingControls() {
    const rows = Array.from(mappingsBody.children);
    el('accountsEmpty').hidden = rows.length > 0;
    for (const row of rows) {
      const handle = row.querySelector('.mapping-drag');
      handle.disabled = rows.length < 2;
      handle.draggable = rows.length > 1;
    }
  }

  function announceMove(row) {
    const name =
      row.querySelector('.mapping-label').value ||
      row.querySelector('.mapping-account').value ||
      'Account';
    const position = Array.from(mappingsBody.children).indexOf(row) + 1;
    el('mappingOrderStatus').textContent =
      `${name} moved to position ${position}. Save Settings to keep this order.`;
    markDirty();
    row.querySelector('.mapping-drag').focus();
  }

  function addAccountRow(account = {}) {
    const row = document.createElement('tr');
    if (account.portalName !== undefined) row.dataset.portalName = account.portalName;
    row.innerHTML = `
      <td><button type="button" class="mapping-drag" aria-label="Reorder account" aria-describedby="mappingOrderHint" title="Drag to reorder. Use Alt+Up or Alt+Down with the keyboard."><svg viewBox="0 0 16 20" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="10" r="1.5"/><circle cx="11" cy="10" r="1.5"/><circle cx="5" cy="16" r="1.5"/><circle cx="11" cy="16" r="1.5"/></svg></button></td>
      <td><input type="text" aria-label="Account name" class="mapping-label" value="${escapeHtml(account.label)}" placeholder="Production"></td>
      <td><input type="text" aria-label="AWS account ID" inputmode="numeric" maxlength="12" class="mapping-account" value="${escapeHtml(account.accountId)}" placeholder="123456789012"></td>
      <td><input type="text" aria-label="Role override (optional)" class="mapping-role" value="${escapeHtml(account.roleName)}" placeholder="Use default"></td>
      <td><input type="text" aria-label="URL keyword (optional)" class="mapping-keyword" value="${escapeHtml(account.keyword)}" placeholder="Optional"></td>
      <td><button type="button" class="btn-delete" title="Remove account" aria-label="Remove account">&times;</button></td>`;
    row.querySelector('.btn-delete').addEventListener('click', () => {
      row.remove();
      updateMappingControls();
      markDirty();
    });
    const handle = row.querySelector('.mapping-drag');
    handle.addEventListener('keydown', (event) => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const up = event.key === 'ArrowUp';
      const sibling = up ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      if (up) mappingsBody.insertBefore(row, sibling);
      else mappingsBody.insertBefore(sibling, row);
      announceMove(row);
    });
    handle.addEventListener('dragstart', (event) => {
      draggedRow = row;
      orderBeforeDrag = Array.from(mappingsBody.children);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(orderBeforeDrag.indexOf(row)));
      row.classList.add('is-dragging');
    });
    handle.addEventListener('dragend', () => {
      if (!draggedRow) return;
      mappingsBody.append(...orderBeforeDrag);
      row.classList.remove('is-dragging');
      draggedRow = null;
      orderBeforeDrag = [];
      handle.focus();
    });
    mappingsBody.appendChild(row);
  }

  function renderAccounts(accounts) {
    mappingsBody.replaceChildren();
    for (const account of accounts) addAccountRow(account);
    updateMappingControls();
  }

  mappingsBody.addEventListener('dragover', (event) => {
    if (!draggedRow) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = event.target.closest('tr');
    if (!target || target === draggedRow || target.parentElement !== mappingsBody) return;
    const rect = target.getBoundingClientRect();
    const reference =
      event.clientY < rect.top + rect.height / 2 ? target : target.nextElementSibling;
    if (reference !== draggedRow && reference !== draggedRow.nextElementSibling)
      mappingsBody.insertBefore(draggedRow, reference);
  });
  mappingsBody.addEventListener('drop', (event) => {
    if (!draggedRow) return;
    event.preventDefault();
    const row = draggedRow;
    const changed = orderBeforeDrag.some(
      (previous, index) => mappingsBody.children[index] !== previous,
    );
    row.classList.remove('is-dragging');
    draggedRow = null;
    orderBeforeDrag = [];
    if (changed) announceMove(row);
  });

  document.addEventListener('input', markDirty);
  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      saveAll();
    }
  });
  el('addMapping').addEventListener('click', () => {
    addAccountRow();
    updateMappingControls();
    markDirty();
    mappingsBody.lastElementChild.querySelector('.mapping-account').focus();
  });
  document
    .querySelectorAll('input[name="fallbackBehavior"]')
    .forEach((radio) => radio.addEventListener('change', updateDefaultAccountVisibility));
  el('portalUrl').addEventListener('blur', (event) => {
    event.target.value = normalizePortalUrl(event.target.value) || event.target.value.trim();
  });
  el('saveBtn').addEventListener('click', saveAll);
  el('importPortal').addEventListener('click', importFromPortal);

  try {
    ({ settings } = await request({ type: MESSAGES.GET_SETTINGS }));
    originalAccountIds = settings.accountMappings.map((account) => account.accountId);
    for (const key of ['enabled', 'portalUrl', 'roleName', 'defaultAccountId']) {
      if (key === 'enabled') el(key).checked = settings[key];
      else el(key).value = settings[key];
    }
    const radio = document.querySelector(
      `input[name="fallbackBehavior"][value="${settings.fallbackBehavior}"]`,
    );
    if (radio) radio.checked = true;
    updateDefaultAccountVisibility();
    renderAccounts(settings.accountMappings);
  } catch (error) {
    status('saveStatus', error.message, 'error');
    el('saveBtn').disabled = true;
    el('importPortal').disabled = true;
    el('addMapping').disabled = true;
  }

  async function saveAll() {
    if (!settings || el('saveBtn').disabled) return;
    document.querySelectorAll('.error').forEach((element) => {
      element.textContent = '';
    });
    document
      .querySelectorAll('[aria-invalid]')
      .forEach((element) => element.removeAttribute('aria-invalid'));
    const invalidate = (input, messageId, message) => {
      input.setAttribute('aria-invalid', 'true');
      if (messageId) el(messageId).textContent = message;
    };
    const portalUrl = normalizePortalUrl(el('portalUrl').value);
    const roleName = el('roleName').value.trim();
    const defaultAccountId = el('defaultAccountId').value.trim();
    const fallbackBehavior = getRadio('fallbackBehavior', 'prompt');
    if (!portalUrl)
      invalidate(
        el('portalUrl'),
        'portalUrlError',
        'Enter a valid HTTPS AWS portal, such as mycompany.awsapps.com.',
      );
    if (!roleName)
      invalidate(
        el('roleName'),
        'roleNameError',
        'Enter the permission set or role name from your portal.',
      );
    if (fallbackBehavior === 'default' && !isValidAccountId(defaultAccountId))
      invalidate(
        el('defaultAccountId'),
        'defaultAccountIdError',
        'Enter the default account ID: exactly 12 digits.',
      );
    const accounts = draftAccounts();
    Array.from(mappingsBody.children).forEach((row, index) => {
      const account = accounts[index];
      if (
        (account.keyword || account.accountId || account.label || account.roleName) &&
        !isValidAccountId(account.accountId)
      )
        invalidate(row.querySelector('.mapping-account'));
    });
    if (document.querySelector('[aria-invalid="true"]')) {
      status(
        'saveStatus',
        'Check the highlighted fields. Account IDs must contain 12 digits.',
        'error',
      );
      document.querySelector('[aria-invalid="true"]').focus();
      return;
    }
    const savedRevision = revision;
    el('saveBtn').disabled = true;
    el('saveBtn').textContent = 'Saving…';
    try {
      const response = await request({
        type: MESSAGES.SAVE_SETTINGS,
        originalAccountIds,
        settings: {
          ...settings,
          portalUrl,
          roleName,
          defaultAccountId,
          fallbackBehavior,
          enabled: el('enabled').checked,
          accountMappings: accounts.filter((account) => isValidAccountId(account.accountId)),
        },
      });
      settings = response.settings;
      if (revision === savedRevision) {
        renderAccounts(settings.accountMappings);
        originalAccountIds = settings.accountMappings.map((account) => account.accountId);
        el('portalUrl').value = portalUrl;
        dirty = false;
        status('saveStatus', 'Settings saved', 'success');
      } else status('saveStatus', 'Settings saved. You have new unsaved changes.');
    } catch (error) {
      status('saveStatus', error.message, 'error');
    } finally {
      el('saveBtn').disabled = false;
      el('saveBtn').textContent = 'Save Settings';
    }
  }

  async function importFromPortal() {
    const portalUrl = normalizePortalUrl(el('portalUrl').value);
    if (!portalUrl) {
      status('importStatus', 'Enter a valid AWS portal URL first.', 'error');
      el('portalUrl').focus();
      return;
    }
    el('importPortal').disabled = true;
    el('importPortal').textContent = 'Waiting for portal…';
    status(
      'importStatus',
      'Sign in to your portal. AccountHop will check for accounts for up to a minute.',
    );
    try {
      const tabs = await chrome.tabs.query({ url: `https://${portalUrl}/*` });
      let tab = tabs.find((candidate) => new URL(candidate.url).pathname.startsWith('/start'));
      tab = tab
        ? await chrome.tabs.update(tab.id, { active: true })
        : await chrome.tabs.create({ url: `https://${portalUrl}/start/`, active: true });
      const deadline = Date.now() + 60000;
      let previous = '';
      while (Date.now() < deadline) {
        await chrome.tabs.get(tab.id);
        let accounts = [];
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            type: MESSAGES.SCRAPE_PORTAL_ACCOUNTS,
          });
          accounts = (response?.accounts || []).filter((account) =>
            isValidAccountId(account.accountId),
          );
        } catch {
          /* The portal may still be loading or waiting for sign-in. */
        }
        const signature = JSON.stringify(accounts);
        if (accounts.length && signature === previous) {
          renderAccounts(mergeImportedAccounts(draftAccounts(), accounts));
          markDirty();
          const count = new Set(accounts.map((account) => account.accountId)).size;
          status(
            'importStatus',
            `Imported ${count} account${count === 1 ? '' : 's'}. Save Settings to keep them.`,
            'success',
          );
          return;
        }
        previous = signature;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(
        'No accounts found. Finish signing in, expand the AWS accounts list, then try again.',
      );
    } catch (error) {
      status(
        'importStatus',
        error.message || 'Import failed. Keep the portal open and try again.',
        'error',
      );
    } finally {
      el('importPortal').disabled = false;
      el('importPortal').textContent = 'Import from Portal';
    }
  }
});
