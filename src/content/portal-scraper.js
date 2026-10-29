(() => {
  const { MESSAGES, isValidAccountId } = self.AWSAutoLogin || {};
  if (!MESSAGES || !window.location.pathname.startsWith('/start')) return;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === MESSAGES.SCRAPE_PORTAL_ACCOUNTS) {
      sendResponse({ accounts: scrapeAccounts() });
    }
  });

  function scrapeAccounts() {
    const accounts = new Map();
    const textCache = new WeakMap();
    const nameSelector = [
      '[data-testid="account-name"]',
      '[data-testid="accountName"]',
      '[data-testid*="account-name"]',
      '[class*="account-name"]',
      '[class*="accountName"]',
      '[class*="AccountName"]',
    ].join(', ');

    function addAccount(accountId, label, priority) {
      if (!isValidAccountId(accountId)) return;
      const name = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      const existing = accounts.get(accountId);
      if (!existing || (name && (!existing.label || priority > existing.priority))) {
        accounts.set(accountId, { accountId, label: name, priority });
      }
    }

    function textNodes(element) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement?.closest('script, style, noscript')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      return nodes;
    }

    function textParts(element) {
      if (!textCache.has(element)) {
        textCache.set(
          element,
          textNodes(element)
            .map((node) => node.textContent.trim())
            .filter(Boolean),
        );
      }
      return textCache.get(element);
    }

    function idsIn(text) {
      return [...text.matchAll(/(?<!\d)\d{12}(?!\d)/g)].map((match) => match[0]);
    }

    for (const node of document.body ? textNodes(document.body) : []) {
      for (const accountId of idsIn(node.textContent)) {
        addAccount(accountId, '', 0);
        let element = node.parentElement;
        for (let depth = 0; element && element !== document.body && depth < 12; depth++) {
          const parts = textParts(element);
          const text = parts.join(' ');
          if (new Set(idsIn(text)).size !== 1) break;
          const nameElement = element.matches(nameSelector)
            ? element
            : element.querySelector(nameSelector);
          if (nameElement) addAccount(accountId, nameElement.textContent, 3);
          const beforeId = text
            .slice(0, text.indexOf(accountId))
            .replace(/(?:^|\s)(?:AWS\s+)?Account\s*ID\s*[:#(]*\s*$/i, '')
            .replace(/[\s|#(]+$/, '')
            .trim();
          if (beforeId && !beforeId.includes('@')) addAccount(accountId, beforeId, 1);
          element = element.parentElement;
        }
      }
    }

    function walk(value, depth = 0) {
      if (depth > 10 || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      const id = value.accountId || value.account_id || value.accountID || value.id;
      addAccount(id, value.accountName || value.account_name || value.name || value.label, 2);
      for (const item of Object.values(value)) walk(item, depth + 1);
    }

    for (const script of document.querySelectorAll(
      'script[type="application/json"], script#__NEXT_DATA__',
    )) {
      try {
        walk(JSON.parse(script.textContent));
      } catch {
        continue;
      }
    }
    return [...accounts.values()].map(({ accountId, label }) => ({ accountId, label }));
  }
})();
