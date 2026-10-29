(() => {
  const { MESSAGES, escapeHtml, getAccountChoices, isValidAccountId } = self.AWSAutoLogin || {};
  if (!MESSAGES) return;
  let bannerShown = false;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== MESSAGES.GET_CURRENT_ACCOUNT) return;
    let accountId = '';
    let alias = '';
    try {
      const data = JSON.parse(
        document.querySelector('meta[name="awsc-session-data"]')?.content || '{}',
      );
      accountId = typeof data.accountId === 'string' ? data.accountId : '';
      alias = typeof data.accountAlias === 'string' ? data.accountAlias : '';
    } catch {
      /* AWS session metadata may not be available yet. */
    }
    if (!isValidAccountId(accountId)) {
      const menu = document.querySelector(
        '[data-testid="aws-my-account-details"], #nav-usernameMenu',
      );
      const match = menu?.textContent?.match(/(?:^|\D)(\d{4})-?(\d{4})-?(\d{4})(?!\d)/);
      accountId = match ? match.slice(1).join('') : '';
    }
    respond(isValidAccountId(accountId) ? { accountId, alias } : null);
  });

  init().catch((error) => console.debug('[AccountHop] Could not check this page:', error.message));

  async function init() {
    const { wasRedirected } = await chrome.runtime.sendMessage({
      type: MESSAGES.WAS_RECENTLY_REDIRECTED,
    });
    if (wasRedirected) return;
    const response = await chrome.runtime.sendMessage({ type: MESSAGES.SHOW_CHOOSER });
    if (!response?.available) return;
    if (response.pending) {
      showBanner(response);
      return;
    }
    setTimeout(async () => {
      if (!detectAccessDenied()) return;
      try {
        showBanner(await chrome.runtime.sendMessage({ type: MESSAGES.SHOW_CHOOSER }));
      } catch (error) {
        console.debug('[AccountHop] Could not show account chooser:', error.message);
      }
    }, 3000);
  }

  function detectAccessDenied() {
    const text =
      `${document.title} ${(document.body?.innerText || '').slice(0, 5000)}`.toLowerCase();
    return [
      'you are not authorized',
      'access denied',
      'session expired',
      'not authenticated',
      'sign in to the console',
      'you need to be signed in',
      "you don't have permissions",
    ].some((phrase) => text.includes(phrase));
  }

  function showBanner(response) {
    if (bannerShown || !response?.available || !document.body) return;
    bannerShown = true;
    const detection = response.pending?.detection;
    const originalUrl = response.originalUrl || window.location.href;
    const accounts = getAccountChoices(response.accountMappings);
    if (
      detection?.accountId &&
      !accounts.some((account) => account.accountId === detection.accountId)
    ) {
      accounts.unshift({
        accountId: detection.accountId,
        label: detection.label || 'Suggested account',
        roleName: detection.roleName,
      });
    }
    const info =
      detection?.matchSource === 'ambiguous'
        ? 'This link matches more than one account or role. Choose the account you need.'
        : 'Open this console link through your AWS access portal.';
    const host = document.createElement('div');
    host.id = 'aws-auto-login-banner-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    const options = accounts
      .map(
        (account) =>
          `<option value="${account.accountId}" data-role="${escapeHtml(account.roleName || '')}">${escapeHtml(account.label)} (${account.accountId})${account.roleName ? ` · ${escapeHtml(account.roleName)}` : ''}</option>`,
      )
      .join('');
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .banner { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; background: #232f3e; color: #fff; font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 12px 16px; display: flex; align-items: center; flex-wrap: wrap; gap: 12px; box-shadow: 0 2px 8px #0005; }
        .text { flex: 1 1 220px; }
        p { margin: 2px 0 0; color: #c4d0db; font-size: 12px; }
        select, input { min-width: 0; max-width: 100%; padding: 7px 8px; border: 1px solid #82919e; border-radius: 4px; background: #fff; color: #172b3a; font: inherit; }
        select { width: min(320px, 100%); }
        input { width: 156px; }
        button { padding: 8px 12px; border: 1px solid transparent; border-radius: 4px; font: inherit; cursor: pointer; }
        .go { background: #ffb33b; color: #172b3a; font-weight: 600; }
        .go:disabled { opacity: .6; cursor: default; }
        .dismiss { background: transparent; color: #fff; border-color: #82919e; }
        :focus-visible { outline: 2px solid #7ac5f5; outline-offset: 3px; }
        .error { flex-basis: 100%; color: #ffb4ac; }
        [hidden] { display: none !important; }
      </style>
      <section class="banner" aria-label="AccountHop account chooser">
        <div class="text"><strong>AccountHop for AWS</strong><p>${info}</p></div>
        <select id="sel" aria-label="AWS account"><option value="">Choose an account…</option>${options}<option value="other">Enter another account ID…</option></select>
        <input id="manual" aria-label="12-digit AWS account ID" inputmode="numeric" maxlength="12" placeholder="12-digit account ID" hidden>
        <button class="go" id="go" disabled>Open account</button>
        <button class="dismiss" id="x">Dismiss</button>
        <p id="error" class="error" role="alert" hidden></p>
      </section>`;
    document.body.prepend(host);
    const select = shadow.getElementById('sel');
    const manual = shadow.getElementById('manual');
    const go = shadow.getElementById('go');
    const error = shadow.getElementById('error');
    const accountId = () => (select.value === 'other' ? manual.value.trim() : select.value);
    const update = () => {
      manual.hidden = select.value !== 'other';
      go.disabled = !isValidAccountId(accountId());
    };
    if (!accounts.length) select.value = 'other';
    update();
    select.addEventListener('change', () => {
      update();
      if (!manual.hidden) manual.focus();
    });
    manual.addEventListener('input', update);
    const dismiss = () => {
      host.remove();
      bannerShown = false;
    };
    shadow.getElementById('x').addEventListener('click', dismiss);
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') dismiss();
    });
    go.addEventListener('click', async () => {
      if (!isValidAccountId(accountId())) return;
      go.disabled = true;
      go.textContent = 'Opening…';
      error.hidden = true;
      try {
        const response = await chrome.runtime.sendMessage({
          type: MESSAGES.REDIRECT_WITH_ACCOUNT,
          url: originalUrl,
          accountId: accountId(),
          roleName: select.selectedOptions[0]?.dataset.role || null,
        });
        if (!response?.success)
          throw new Error(response?.error || 'Could not open this account. Try again.');
        host.remove();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
        go.textContent = 'Open account';
        update();
      }
    });
  }
})();
