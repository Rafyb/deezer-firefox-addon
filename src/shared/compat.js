// Firefox / Chrome differences, in one place. Imported first by the
// background, the popup and the options page (the content script, not a
// module, has its own two lines).

// Chrome exposes the same promise-based API as `chrome` (and as `browser` in
// recent versions only).
globalThis.browser ??= globalThis.chrome;

// getBrowserInfo() only exists in Firefox.
export const IS_FIREFOX = typeof browser.runtime.getBrowserInfo === "function";

// Context menu API: `menus` in Firefox, `contextMenus` in Chrome. None on
// Firefox for Android.
export const menus = browser.menus ?? browser.contextMenus ?? null;

// Hidden tabs (tabHide API) and changing shortcuts from the extension are
// Firefox only.
export const CAN_HIDE_TABS = typeof browser.tabs.hide === "function";
export const CAN_SET_SHORTCUTS = typeof browser.commands?.update === "function";

// "*://www.deezer.com/*" -> /^https?:\/\/www\.deezer\.com\/.*$/
function matchPatternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/^\*:/, "https?:")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// tabs.onUpdated with Firefox's filter ({ properties, urls }). Chrome has no
// filter: the same checks run in the listener.
export function onTabUpdated(listener, { properties, urls } = {}) {
  if (IS_FIREFOX) {
    const filter = {};
    if (properties) filter.properties = properties;
    if (urls) filter.urls = urls;
    browser.tabs.onUpdated.addListener(listener, filter);
    return;
  }
  const patterns = urls?.map(matchPatternToRegExp);
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (properties && !properties.some((p) => p in changeInfo)) return;
    if (patterns && !patterns.some((re) => re.test(tab.url ?? ""))) return;
    listener(tabId, changeInfo, tab);
  });
}

// Messages: the reply goes through sendResponse, which every Chrome version
// supports (returning a promise from the listener doesn't work in older ones).
// A rejected handler is sent back as an error and rethrown by send().
const ERROR_KEY = "__remoteError";

// handler(message, sender) returns undefined (not for this listener: another
// one may answer) or the reply (value or promise).
export function onMessage(handler) {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = handler(message, sender);
    if (result === undefined) return false;
    Promise.resolve(result).then(
      (value) => sendResponse(value),
      (err) => sendResponse({ [ERROR_KEY]: err?.message ?? String(err) }),
    );
    return true;
  });
}

export async function send(message) {
  const reply = await browser.runtime.sendMessage(message);
  if (reply && typeof reply === "object" && ERROR_KEY in reply) throw new Error(reply[ERROR_KEY]);
  return reply;
}
