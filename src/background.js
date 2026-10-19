// Background (event page): routes popup and keyboard shortcut commands to the
// Deezer tab, and manages the hidden Deezer tab.

const DEEZER_URL = "https://www.deezer.com/";
const DEEZER_MATCH = "*://www.deezer.com/*";

const READY_TIMEOUT_MS = 15000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Prefer the tab playing sound, then a loaded tab, then a sleeping one.
async function findDeezerTab() {
  const tabs = await browser.tabs.query({ url: DEEZER_MATCH });
  return tabs.find((t) => t.audible) ?? tabs.find((t) => !t.discarded) ?? tabs[0] ?? null;
}

function describeTab(tab) {
  return tab
    ? {
        id: tab.id,
        windowId: tab.windowId,
        hidden: !!tab.hidden,
        muted: !!tab.mutedInfo?.muted,
        discarded: !!tab.discarded,
        audible: !!tab.audible,
      }
    : null;
}

async function sendToDeezer(tab, message) {
  try {
    return await browser.tabs.sendMessage(tab.id, message);
  } catch {
    // Content script not loaded yet (tab still loading).
    return { available: false };
  }
}

// Firefox restores tabs without loading them (discarded): no page means no
// content script. reload() loads the tab without showing it.
async function wake(tab) {
  if (tab.discarded) await browser.tabs.reload(tab.id);
}

// Safety net: loaded tab without a content script (failed injection, reloaded
// extension…). The content script guards against double injection.
async function ensureContentScript(tab) {
  if (tab.discarded || tab.status !== "complete") return;
  try {
    await browser.tabs.sendMessage(tab.id, { type: "getState" });
  } catch {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/deezer.js"] });
  }
}

async function waitForPlayer(tab) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await sendToDeezer(tab, { type: "getState" });
    if (state?.available) return true;
    await wait(300);
  }
  return false;
}

// Doesn't block the popup: it receives the state pushed by the content script
// once the tab is awake.
async function getStatus() {
  const tab = await findDeezerTab();
  if (!tab) return { tab: null, state: null };
  if (tab.discarded) {
    await wake(tab);
    return { tab: describeTab(tab), state: { available: false } };
  }
  await ensureContentScript(tab);
  return { tab: describeTab(tab), state: await sendToDeezer(tab, { type: "getState" }) };
}

// Keyboard shortcuts must work on a sleeping tab too: wake it up and wait for
// the player to be ready.
async function runCommand(action, value) {
  const tab = await findDeezerTab();
  if (!tab) return { tab: null, state: null };
  if (tab.discarded) {
    await wake(tab);
    await waitForPlayer(tab);
  } else {
    await ensureContentScript(tab);
  }
  if (STARTS_PLAYBACK.has(action)) await ensureForegroundedOnce(tab.id);
  const state = await sendToDeezer(tab, { type: "command", action, value });
  return { tab: describeTab(await browser.tabs.get(tab.id)), state };
}

// Firefox holds back sound in a tab that has never been in the foreground
// (tab created hidden, tab restored asleep): playback silently stays blocked.
// Remember which tabs have been shown during the session; for the others,
// show the tab for an instant before starting playback.
const STARTS_PLAYBACK = new Set(["togglePlay", "play"]);
const FOREGROUND_FLASH_MS = 300;

async function getVisitedTabs() {
  const { visitedTabs = [] } = await browser.storage.session.get("visitedTabs");
  return new Set(visitedTabs);
}

async function markVisited(tabId) {
  const visited = await getVisitedTabs();
  if (visited.has(tabId)) return;
  visited.add(tabId);
  await browser.storage.session.set({ visitedTabs: [...visited] });
}

browser.tabs.onActivated.addListener(({ tabId }) => markVisited(tabId));

async function ensureForegroundedOnce(tabId) {
  const tab = await browser.tabs.get(tabId);
  // A tab already playing sound isn't held back.
  if (tab.active || tab.audible || (await getVisitedTabs()).has(tabId)) return;
  const state = await sendToDeezer(tab, { type: "getState" });
  // Only flash to start playback, not to pause it.
  if (state?.playing) return;

  const [previous] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  const wasHidden = tab.hidden;
  if (wasHidden) await browser.tabs.show(tab.id);
  await browser.tabs.update(tab.id, { active: true });
  await wait(FOREGROUND_FLASH_MS);
  if (previous) await browser.tabs.update(previous.id, { active: true });
  if (wasHidden) await browser.tabs.hide(tab.id);
}

// Opens Deezer in a hidden tab (tabHide API, Firefox only).
async function launchHidden() {
  const existing = await findDeezerTab();
  if (existing) {
    if (!existing.active && !existing.hidden) await browser.tabs.hide(existing.id);
    return getStatus();
  }
  const tab = await browser.tabs.create({ url: DEEZER_URL, active: false });
  await browser.tabs.hide(tab.id);
  // No getStatus(): the tab is still on about:blank and the URL lookup
  // wouldn't find it. The popup gets the full state once the content script
  // reports the player.
  return { tab: describeTab(await browser.tabs.get(tab.id)), state: { available: false } };
}

async function showTab() {
  const tab = await findDeezerTab();
  if (!tab) return getStatus();
  if (tab.hidden) await browser.tabs.show(tab.id);
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  return getStatus();
}

async function hideTab() {
  const tab = await findDeezerTab();
  // Firefox refuses to hide the active tab: switch to another one first.
  if (tab && !tab.hidden) {
    if (tab.active) {
      const others = await browser.tabs.query({ windowId: tab.windowId, hidden: false });
      const fallback = others.filter((t) => t.id !== tab.id).sort((a, b) => b.lastAccessed - a.lastAccessed)[0];
      if (!fallback) return getStatus();
      await browser.tabs.update(fallback.id, { active: true });
    }
    await browser.tabs.hide(tab.id);
  }
  return getStatus();
}

async function toggleMute() {
  const tab = await findDeezerTab();
  if (tab) await browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  return getStatus();
}

const HANDLERS = {
  "remote:getStatus": () => getStatus(),
  "remote:command": (msg) => runCommand(msg.action, msg.value),
  "remote:launchHidden": () => launchHidden(),
  "remote:showTab": () => showTab(),
  "remote:hideTab": () => hideTab(),
  "remote:toggleMute": () => toggleMute(),
};

browser.runtime.onMessage.addListener((message) => {
  const handler = HANDLERS[message?.type];
  return handler ? handler(message) : undefined;
});

const COMMANDS = {
  "toggle-play": "togglePlay",
  "next-track": "next",
  "previous-track": "previous",
  "toggle-like": "toggleLike",
};

browser.commands.onCommand.addListener((command) => {
  const action = COMMANDS[command];
  if (action) runCommand(action);
});
