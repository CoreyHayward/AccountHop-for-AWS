self.AWSAutoLogin = self.AWSAutoLogin || {};

AWSAutoLogin.parseUrlContext = function (urlString) {
  try {
    const url = new URL(urlString);
    const prefix = url.hostname
      .replace(/\.?console\.aws\.amazon\.com$/, '')
      .split('.')
      .filter(Boolean);
    const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
    const region =
      prefix.find((part) => regionPattern.test(part)) || url.searchParams.get('region') || null;
    const service =
      prefix.find((part) => !regionPattern.test(part)) ||
      url.pathname.split('/').filter(Boolean)[0] ||
      null;
    const resource = AWSAutoLogin.safeDecode(urlString).match(
      /\/\d{12}\/([a-zA-Z0-9][a-zA-Z0-9._-]+)/,
    );
    const parts = resource?.[1].split('-') || [];
    const resourcePattern = parts.length >= 2 ? parts.slice(0, 2).join('-') + '-*' : null;
    return { service, region, resourcePattern };
  } catch {
    return { service: null, region: null, resourcePattern: null };
  }
};

function keywordMatches(url, keyword) {
  let index = url.indexOf(keyword);
  while (index !== -1) {
    const before = url[index - 1] || '';
    const after = url[index + keyword.length] || '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    index = url.indexOf(keyword, index + 1);
  }
  return false;
}

function learnedSuggestion(urlString, learnedAccounts) {
  const context = AWSAutoLogin.parseUrlContext(urlString);
  let best = null;
  let bestScore = 0;
  for (const entry of Object.values(learnedAccounts || {})) {
    if (!AWSAutoLogin.isValidAccountId(entry.accountId)) continue;
    let score = 0;
    if (
      context.service &&
      !AWSAutoLogin.GENERIC_SERVICES.has(context.service) &&
      entry.services?.includes(context.service)
    )
      score++;
    if (context.region && entry.regions?.includes(context.region)) score++;
    if (context.resourcePattern && entry.resourcePatterns?.includes(context.resourcePattern))
      score += 2;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best
    ? {
        accountId: best.accountId,
        confidence: 'low',
        matchSource: 'learned-suggestion',
        label: best.label || null,
      }
    : null;
}

AWSAutoLogin.detectAccount = function (urlString, accountMappings = [], learnedAccounts = {}) {
  const noMatch = { accountId: null, confidence: 'low', matchSource: 'none', label: null };
  if (!AWSAutoLogin.isAwsConsoleUrl(urlString)) return noMatch;
  const url = new URL(urlString);
  const decoded = AWSAutoLogin.safeDecode(urlString);
  const candidates = new Map();
  const addCandidate = (id, source) => {
    if (AWSAutoLogin.isValidAccountId(id) && !candidates.has(id)) candidates.set(id, source);
  };
  const names = ['accountid', 'account_id', 'account'];
  const hashQuery = url.hash.includes('?')
    ? url.hash.slice(url.hash.indexOf('?') + 1)
    : url.hash.slice(1);
  for (const params of [url.searchParams, new URLSearchParams(hashQuery)]) {
    for (const [key, value] of params) {
      if (names.includes(key.toLowerCase())) addCandidate(value, 'url-param');
    }
  }
  for (const segment of AWSAutoLogin.safeDecode(url.pathname + '/' + url.hash).split(/[/?#&]/)) {
    addCandidate(segment, 'url-path');
  }
  for (const match of decoded.matchAll(/amazonaws\.com\/(\d{12})\//g))
    addCandidate(match[1], 'aws-service-url');
  for (const match of decoded.matchAll(/arn:aws[a-z-]*:[^:]*:[^:]*:(\d{12})(?=[:/]|$)/gi))
    addCandidate(match[1], 'arn');

  const mappings = accountMappings.filter((m) => AWSAutoLogin.isValidAccountId(m.accountId));
  const matchingKeywords = mappings.filter(
    (m) =>
      m.keyword?.trim() && keywordMatches(decoded.toLowerCase(), m.keyword.trim().toLowerCase()),
  );
  if (candidates.size > 1) return { ...noMatch, matchSource: 'ambiguous' };
  if (candidates.size === 1) {
    const [accountId, matchSource] = candidates.entries().next().value;
    const choices = mappings.filter((m) => m.accountId === accountId);
    const matching = matchingKeywords.filter((m) => m.accountId === accountId);
    const roles = new Set((matching.length ? matching : choices).map((m) => m.roleName || ''));
    if (roles.size > 1) return { ...noMatch, matchSource: 'ambiguous' };
    return {
      accountId,
      matchSource,
      confidence: 'high',
      label: matching[0]?.label || choices[0]?.label || null,
      roleName: roles.size === 1 ? [...roles][0] || null : null,
    };
  }
  if (
    new Set(matchingKeywords.map((m) => m.accountId)).size > 1 ||
    new Set(matchingKeywords.map((m) => m.roleName || '')).size > 1
  ) {
    return { ...noMatch, matchSource: 'ambiguous' };
  }
  if (matchingKeywords.length) {
    const mapping = matchingKeywords[0];
    return {
      accountId: mapping.accountId,
      confidence: 'high',
      matchSource: 'exact-mapping',
      label: mapping.label || null,
      roleName: mapping.roleName || null,
    };
  }
  return learnedSuggestion(urlString, learnedAccounts) || noMatch;
};
