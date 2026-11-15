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

// Sleep timer: an alarm rather than setTimeout, which wouldn't survive the
// event page being unloaded. The alarm's scheduled time is the only state.
const SLEEP_ALARM = "sleep-timer";

async function getSleepTimer() {
  const alarm = await browser.alarms.get(SLEEP_ALARM);
  return { end: alarm?.scheduledTime ?? null };
}

async function setSleepTimer(minutes) {
  await browser.alarms.clear(SLEEP_ALARM);
  if (minutes > 0) await browser.alarms.create(SLEEP_ALARM, { delayInMinutes: minutes });
  return getSleepTimer();
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SLEEP_ALARM) return;
  // No need to wake a sleeping tab: it isn't playing.
  const tab = await findDeezerTab();
  if (tab && !tab.discarded) await sendToDeezer(tab, { type: "command", action: "fadeOutAndPause" });
});

// Toolbar icon tooltip: current track, or the extension name (manifest
// default) when nothing is loaded.
let actionTitle = null;

function updateActionTitle(state) {
  const title = state?.available && state.title ? `${state.title} - ${state.artists.join(", ")}` : null;
  if (title === actionTitle) return;
  actionTitle = title;
  browser.action.setTitle({ title });
}

browser.tabs.onRemoved.addListener(async () => {
  if (!(await findDeezerTab())) updateActionTitle(null);
});

// Keyboard shortcuts on/off from the popup. Ignoring the commands wouldn't be
// enough: the key combinations would stay taken from other apps and pages.
// Turning off clears every shortcut and keeps them (including the user's own
// choices) to restore them later; their presence means "off".
async function getShortcuts() {
  const { savedShortcuts } = await browser.storage.local.get("savedShortcuts");
  return { enabled: !savedShortcuts };
}

async function setShortcuts(enabled) {
  const { savedShortcuts } = await browser.storage.local.get("savedShortcuts");
  if (!enabled && !savedShortcuts) {
    const commands = await browser.commands.getAll();
    const saved = Object.fromEntries(commands.filter((c) => c.shortcut).map((c) => [c.name, c.shortcut]));
    await browser.storage.local.set({ savedShortcuts: saved });
    for (const name of Object.keys(saved)) await browser.commands.update({ name, shortcut: "" });
  } else if (enabled && savedShortcuts) {
    for (const [name, shortcut] of Object.entries(savedShortcuts)) {
      await browser.commands.update({ name, shortcut });
    }
    await browser.storage.local.remove("savedShortcuts");
  }
  return getShortcuts();
}

// "Search on Deezer" in the context menu of selected text, can be turned off
// from the popup (on by default). Opens the search in a new tab: navigating
// the Deezer tab would reload it and stop the music.
const SEARCH_MENU = "search-deezer";

async function getSearchMenu() {
  const { searchMenuEnabled = true } = await browser.storage.local.get("searchMenuEnabled");
  return { enabled: searchMenuEnabled };
}

async function createSearchMenu() {
  const { enabled } = await getSearchMenu();
  await browser.menus.removeAll();
  browser.menus.create({
    id: SEARCH_MENU,
    // %s: replaced by Firefox with the selected text.
    title: browser.i18n.getMessage("searchOnDeezer"),
    contexts: ["selection"],
    visible: enabled,
  });
}

async function setSearchMenu(enabled) {
  await browser.storage.local.set({ searchMenuEnabled: enabled });
  await createSearchMenu();
  return getSearchMenu();
}

// No menus API on Android.
if (browser.menus) {
  browser.runtime.onInstalled.addListener(createSearchMenu);
  browser.runtime.onStartup.addListener(createSearchMenu);
  browser.menus.onClicked.addListener(onSearchMenuClicked);
}

function onSearchMenuClicked(info, tab) {
  if (info.menuItemId !== SEARCH_MENU) return;
  const query = info.selectionText?.trim();
  if (!query) return;
  browser.tabs.create({
    url: `${DEEZER_URL}search/${encodeURIComponent(query)}`,
    windowId: tab?.windowId,
    index: tab ? tab.index + 1 : undefined,
  });
}

// Auto-pause (opt-in): pause Deezer when another tab starts playing sound
// (video, call…), resume once no other tab is audible. Only resumes what it
// paused itself: the flag is cleared as soon as Deezer plays again by other
// means (user, shortcut). Kept in session storage: the event page may unload
// during a long video.
const DEEZER_URL_PATTERN = /^https?:\/\/www\.deezer\.com\//;
// Pushes sent just before our pause still say "playing": don't let them clear
// the flag.
const AUTO_PAUSE_GRACE_MS = 2000;

const isDeezerTab = (tab) => DEEZER_URL_PATTERN.test(tab.url ?? "");
const isHeard = (tab) => tab.audible && !tab.mutedInfo?.muted;

async function getAutoPause() {
  const { autoPauseEnabled = false } = await browser.storage.local.get("autoPauseEnabled");
  return { enabled: autoPauseEnabled };
}

async function setAutoPause(enabled) {
  await browser.storage.local.set({ autoPauseEnabled: enabled });
  if (!enabled) await browser.storage.session.remove("autoPausedAt");
  return getAutoPause();
}

async function onOtherTabSound(tab) {
  if (isDeezerTab(tab) || !(await getAutoPause()).enabled) return;
  if (isHeard(tab)) {
    const deezer = await findDeezerTab();
    if (!deezer || deezer.discarded) return;
    const state = await sendToDeezer(deezer, { type: "getState" });
    if (!state?.playing) return;
    await browser.storage.session.set({ autoPausedAt: Date.now() });
    await sendToDeezer(deezer, { type: "command", action: "pause" });
  } else {
    await resumeIfQuiet();
  }
}

async function resumeIfQuiet() {
  const { autoPausedAt } = await browser.storage.session.get("autoPausedAt");
  if (!autoPausedAt) return;
  const audible = await browser.tabs.query({ audible: true });
  if (audible.some((t) => !isDeezerTab(t) && isHeard(t))) return;
  await browser.storage.session.remove("autoPausedAt");
  const deezer = await findDeezerTab();
  if (deezer && !deezer.discarded) await sendToDeezer(deezer, { type: "command", action: "play" });
}

async function clearAutoPauseIfPlaying(state) {
  if (!state?.playing) return;
  const { autoPausedAt } = await browser.storage.session.get("autoPausedAt");
  if (autoPausedAt && Date.now() - autoPausedAt > AUTO_PAUSE_GRACE_MS) {
    await browser.storage.session.remove("autoPausedAt");
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => onOtherTabSound(tab), {
  properties: ["audible", "mutedInfo"],
});
// A closed tab doesn't always report audible: false first.
browser.tabs.onRemoved.addListener(() => resumeIfQuiet());

// Opens Deezer's queue panel, then brings the tab to the front.
async function showQueue() {
  const { state } = await runCommand("openQueue");
  if (state?.error) return { ...(await getStatus()), state };
  return showTab();
}

// Track change notification, opt-in from the options page (optional
// "notifications" permission). The content script pushes its state several
// times a second while playing: checks are chained so that concurrent pushes
// don't notify the same track twice. The last track is kept in session
// storage: the event page unloads while Deezer is paused.
const TRACK_NOTIFICATION = "track";
let trackCheck = Promise.resolve();

function onPlayerState(tab, state) {
  trackCheck = trackCheck.then(() => notifyTrackChange(tab, state)).catch(() => {});
}

async function notifyTrackChange(tab, state) {
  if (!state?.available || !state.playing || !state.title) return;
  const track = `${state.title} - ${state.artists.join(", ")}`;
  const { lastTrack } = await browser.storage.session.get("lastTrack");
  if (track === lastTrack) return;
  await browser.storage.session.set({ lastTrack: track });

  const { notifyTrackChange: enabled = false } = await browser.storage.local.get("notifyTrackChange");
  if (!enabled || !browser.notifications) return;
  // Deezer already on screen: nothing to tell.
  if (tab.active && !tab.hidden && (await browser.windows?.get(tab.windowId))?.focused) return;

  const options = { type: "basic", title: state.title, message: state.artists.join(", ") };
  await browser.notifications.clear(TRACK_NOTIFICATION);
  try {
    await browser.notifications.create(TRACK_NOTIFICATION, { ...options, iconUrl: state.cover ?? undefined });
  } catch {
    // Cover refused as an icon: notify without it.
    await browser.notifications.create(TRACK_NOTIFICATION, options);
  }
}

// The notifications API only exists once the optional permission is granted,
// possibly after this page started.
let notificationClickListening = false;
function listenNotificationClick() {
  if (notificationClickListening || !browser.notifications) return;
  notificationClickListening = true;
  browser.notifications.onClicked.addListener((id) => {
    if (id === TRACK_NOTIFICATION) showTab();
  });
}
listenNotificationClick();
browser.permissions.onAdded.addListener(listenNotificationClick);

const HANDLERS = {
  "remote:getSleepTimer": () => getSleepTimer(),
  "remote:getShortcuts": () => getShortcuts(),
  "remote:setShortcuts": (msg) => setShortcuts(msg.enabled),
  "remote:showQueue": () => showQueue(),
  "remote:getSearchMenu": () => getSearchMenu(),
  "remote:getAutoPause": () => getAutoPause(),
  "remote:setAutoPause": (msg) => setAutoPause(msg.enabled),
  "remote:setSearchMenu": (msg) => setSearchMenu(msg.enabled),
  "remote:setSleepTimer": (msg) => setSleepTimer(msg.minutes),
  "remote:getStatus": () => getStatus(),
  "remote:command": (msg) => runCommand(msg.action, msg.value),
  "remote:launchHidden": () => launchHidden(),
  "remote:showTab": () => showTab(),
  "remote:hideTab": () => hideTab(),
  "remote:toggleMute": () => toggleMute(),
};

browser.runtime.onMessage.addListener((message, sender) => {
  // State pushed by the content script (also received by an open popup).
  if (message?.type === "state" && sender.tab) {
    updateActionTitle(message.state);
    clearAutoPauseIfPlaying(message.state);
    onPlayerState(sender.tab, message.state);
    return undefined;
  }
  const handler = HANDLERS[message?.type];
  return handler ? handler(message) : undefined;
});

const VOLUME_STEP = 10;

// Shortcut name -> [content script action, value].
const COMMANDS = {
  "toggle-play": ["togglePlay"],
  "next-track": ["next"],
  "previous-track": ["previous"],
  "toggle-like": ["toggleLike"],
  "volume-up": ["changeVolume", VOLUME_STEP],
  "volume-down": ["changeVolume", -VOLUME_STEP],
};

browser.commands.onCommand.addListener((command) => {
  const entry = COMMANDS[command];
  if (entry) runCommand(...entry);
});
