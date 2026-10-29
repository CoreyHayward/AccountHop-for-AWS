const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..', 'src');
const copy = (value) => (value === undefined ? undefined : structuredClone(value));
const event = () => {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: async (...args) => {
      for (const listener of listeners) await listener(...args);
    },
    listeners,
  };
};

function load({
  settings = {},
  learnedAccounts = {},
  session = {},
  worker = false,
  updateError,
} = {}) {
  const localData = copy({ settings, learnedAccounts });
  const sessionData = copy(session);
  const onChanged = event();
  const writes = [];
  const navigations = [];
  const created = [];
  const errors = [];
  function area(data, name) {
    return {
      get: async (keys) => {
        if (keys == null) return copy(data);
        return Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map((key) => [key, copy(data[key])]),
        );
      },
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: copy(data[key]), newValue: copy(value) };
          data[key] = copy(value);
        }
        writes.push({ area: name, values: copy(values) });
        await onChanged.emit(changes, name);
      },
      remove: async (key) => {
        delete data[key];
      },
    };
  }
  const chrome = {
    storage: { local: area(localData, 'local'), session: area(sessionData, 'session'), onChanged },
    webNavigation: { onBeforeNavigate: event() },
    tabs: {
      onRemoved: event(),
      update: async (tabId, options) => {
        if (updateError) throw new Error(updateError);
        navigations.push({ tabId, ...options });
        return { id: tabId, ...options };
      },
      create: async (options) => {
        const tab = { id: 99 + created.length, ...options };
        created.push(tab);
        return tab;
      },
    },
    runtime: { onMessage: event(), getURL: (path) => `chrome-extension://test/${path}` },
  };
  const context = vm.createContext({
    chrome,
    URL,
    URLSearchParams,
    console: { error: (...args) => errors.push(args) },
    Date,
  });
  context.self = context;
  const run = (file) =>
    vm.runInContext(readFileSync(join(root, file), 'utf8'), context, { filename: file });
  context.importScripts = (...files) => files.forEach((file) => run(join('background', file)));
  if (worker) run('background/service-worker.js');
  else ['shared/constants.js', 'shared/storage.js', 'shared/account-detector.js'].forEach(run);
  const message = (payload, sender = {}) =>
    new Promise((resolve) => {
      chrome.runtime.onMessage.listeners[0](payload, sender, resolve);
    });
  const navigate = (url, tabId = 1, frameId = 0) =>
    chrome.webNavigation.onBeforeNavigate.emit({ url, tabId, frameId });
  return {
    api: context.AWSAutoLogin,
    chrome,
    localData,
    sessionData,
    writes,
    navigations,
    created,
    errors,
    message,
    navigate,
  };
}
module.exports = { load };
