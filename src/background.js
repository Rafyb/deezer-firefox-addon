// Background (event page in Firefox, service worker in Chrome): routes popup
// and keyboard shortcut commands to the Deezer tab, and manages the hidden
// Deezer tab (Firefox only).

import { CAN_HIDE_TABS, CAN_SET_SHORTCUTS, menus, onMessage, onTabUpdated } from "./shared/compat.js";

const DEEZER_URL = "https://www.deezer.com/";
const DEEZER_MATCH = "*://www.deezer.com/*";

const READY_TIMEOUT_MS = 15000;

// Notification icon when the cover can't be used (Chrome requires one).
const NOTIFICATION_ICON = "icons/icon-128.png";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Value kept in storage (session storage survives the event page unloading,
// e.g. while Deezer is paused) and mirrored in memory (read on every push
// while playing, or on every sound in any tab). Loaded once: concurrent reads
// share the same load, which never overwrites a value set meanwhile. A failed
// load is retried on the next read.
function storedValue(area, key, defaultValue = null) {
  let value = defaultValue;
  let loaded = false;
  let loading = null;
  return {
    async get() {
      if (!loaded) {
        loading ??= area
          .get(key)
          .then((stored) => {
            if (!loaded) value = stored[key] ?? defaultValue;
            loaded = true;
          })
          .finally(() => (loading = null));
        await loading;
      }
      return value;
    },
    async set(newValue) {
      value = newValue ?? defaultValue;
      loaded = true;
      if (newValue == null) await area.remove(key);
      else await area.set({ [key]: newValue });
    },
  };
}

const sessionValue = (key) => storedValue(browser.storage.session, key);

// Player tab: the Deezer tab that last played (or was launched hidden). Other
// Deezer tabs (search opened from the context menu, a tab opened by hand)
// mustn't take the remote over while the player is paused.
const playerTab = sessionValue("playerTabId");

async function rememberPlayerTab(tabId) {
  if ((await playerTab.get()) !== tabId) await playerTab.set(tabId);
}

// Prefer the tab playing sound, then the player tab, then a loaded tab, then
// a sleeping one.
async function findDeezerTab() {
  const tabs = await browser.tabs.query({ url: DEEZER_MATCH });
  const playerId = await playerTab.get();
  return (
    tabs.find((t) => t.audible) ??
    tabs.find((t) => t.id === playerId) ??
    tabs.find((t) => !t.discarded) ??
    tabs[0] ??
    null
  );
}

function describeTab(tab) {
  return tab
    ? {
        id: tab.id,
        windowId: tab.windowId,
        hidden: !!tab.hidden,
        muted: !!tab.mutedInfo?.muted,
        discarded: !!tab.discarded,
        // Page loaded: a player still missing then isn't just loading (logged
        // out, consent page…).
        loaded: tab.status === "complete",
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
// once the tab is awake. wake: false for the popup's automatic refreshes: a
// tab Firefox just unloaded stays asleep (asleep: true), and no script is
// injected into a page being torn down.
async function getStatus({ wake: wakeTab = true } = {}) {
  const tab = await findDeezerTab();
  if (!tab) return { tab: null, state: null };
  if (tab.discarded) {
    if (!wakeTab) return { tab: describeTab(tab), state: { available: false, asleep: true } };
    await wake(tab);
    return { tab: describeTab(tab), state: { available: false } };
  }
  if (wakeTab) await ensureContentScript(tab);
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

// Opens Deezer in a hidden tab (tabHide API, Firefox only). Elsewhere, in a
// background tab.
async function launchHidden() {
  const existing = await findDeezerTab();
  if (existing) {
    if (CAN_HIDE_TABS && !existing.active && !existing.hidden) await browser.tabs.hide(existing.id);
    return getStatus();
  }
  const tab = await browser.tabs.create({ url: DEEZER_URL, active: false });
  await rememberPlayerTab(tab.id);
  if (CAN_HIDE_TABS) await browser.tabs.hide(tab.id);
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
  if (!CAN_HIDE_TABS) return getStatus();
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
  // A fade may be running (timer just expired): the new choice wins over it.
  // An auto-pause from now on resumes again, without waiting for the fade's
  // answer (up to a few seconds while the volume is restored).
  queueAutoPause(() => (sleepFading = false));
  const tab = await findDeezerTab();
  if (tab && !tab.discarded) await sendToDeezer(tab, { type: "command", action: "cancelFade" });
  return getSleepTimer();
}

// True while the sleep timer's fade runs: an auto-pause then must not resume
// once the other tab goes quiet. Memory is enough: the event page stays loaded
// while it waits for the content script's answer.
let sleepFading = false;

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SLEEP_ALARM) return;
  // In the auto-pause queue: Deezer may already be auto-paused, it mustn't
  // resume either.
  queueAutoPause(async () => {
    sleepFading = true;
    await autoPaused.set(null);
  });
  await autoPauseOp;
  // A new timer set right at expiry (clear() came too late, and its
  // cancelFade before the fade): the new choice wins.
  if (await browser.alarms.get(SLEEP_ALARM)) {
    queueAutoPause(() => (sleepFading = false));
    return;
  }
  try {
    // No need to wake a sleeping tab: it isn't playing.
    const tab = await findDeezerTab();
    if (tab && !tab.discarded) await sendToDeezer(tab, { type: "command", action: "fadeOutAndPause" });
  } finally {
    queueAutoPause(() => (sleepFading = false));
  }
});

// Toolbar icon tooltip: current track, or the extension name (manifest
// name) when nothing is loaded. Follows one tab: the one playing, so that a
// paused second Deezer tab doesn't overwrite it. The followed tab is kept in
// session storage: the title stays displayed after the event page unloads.
let actionTitle;
// Chrome refuses null (Firefox's "back to the manifest default").
const DEFAULT_ACTION_TITLE = browser.i18n.getMessage("extensionName");
const actionTitleTab = sessionValue("actionTitleTab");

// Updates run one after the other: two pushes arriving together (one tab
// playing, one paused) could both see no followed tab, and the paused one win.
let actionTitleOp = Promise.resolve();

function queueActionTitle(fn) {
  actionTitleOp = actionTitleOp.then(fn).catch(() => {});
}

async function updateActionTitle(tabId, state) {
  const followed = await actionTitleTab.get();
  if (followed != null && tabId !== followed && !state?.playing && !(await followedTabGone(followed))) return;
  if (tabId !== followed) await actionTitleTab.set(tabId);
  const title = state?.available && state.title ? `${state.title} - ${state.artists.join(", ")}` : null;
  if (title === actionTitle) return;
  actionTitle = title;
  await browser.action.setTitle({ title: title ?? DEFAULT_ACTION_TITLE });
}

// The followed tab is gone (closed, left Deezer, unloaded by Firefox): back to
// the extension name, the next push from a Deezer tab takes over.
async function forgetActionTitleTab(tabId) {
  if (tabId !== (await actionTitleTab.get())) return;
  actionTitle = null;
  await browser.action.setTitle({ title: DEFAULT_ACTION_TITLE });
  await actionTitleTab.set(null);
}

browser.tabs.onRemoved.addListener((tabId) => queueActionTitle(() => forgetActionTitleTab(tabId)));
onTabUpdated(
  (tabId, changeInfo) => changeInfo.discarded && queueActionTitle(() => forgetActionTitleTab(tabId)),
  { properties: ["discarded"], urls: [DEEZER_MATCH] },
);
// Leaving Deezer in the followed tab: the content script sends a last
// "unavailable" state on pagehide (no "url" listener here, it would wake the
// event page on every navigation in every tab). If that message is lost,
// another Deezer tab's push still takes over once the followed tab isn't on
// Deezer anymore.
async function followedTabGone(followed) {
  const tab = await browser.tabs.get(followed).catch(() => null);
  return !tab || tab.discarded || !isDeezerTab(tab);
}

// Keyboard shortcuts on/off from the popup. Ignoring the commands wouldn't be
// enough: the key combinations would stay taken from other apps and pages.
// Turning off clears every shortcut and keeps them (including the user's own
// choices) to restore them later; their presence means "off". Firefox only:
// Chrome doesn't let an extension change its shortcuts (the popup hides the
// button).
async function getShortcuts() {
  const { savedShortcuts } = await browser.storage.local.get("savedShortcuts");
  return { enabled: !savedShortcuts };
}

// Changes run one after the other: two quick clicks interleaving would save a
// partial list over the user's shortcuts, losing them.
let shortcutsOp = Promise.resolve();

function setShortcuts(enabled) {
  const run = shortcutsOp.then(() => applyShortcuts(enabled));
  shortcutsOp = run.catch(() => {});
  return run;
}

async function applyShortcuts(enabled) {
  const { savedShortcuts } = await browser.storage.local.get("savedShortcuts");
  if (!enabled && !savedShortcuts) {
    await clearShortcuts({});
  } else if (enabled && savedShortcuts) {
    // A shortcut set by hand (about:addons) while off wins over the saved one.
    const current = await browser.commands.getAll();
    const unset = new Set(current.filter((c) => !c.shortcut).map((c) => c.name));
    for (const [name, shortcut] of Object.entries(savedShortcuts)) {
      if (unset.has(name)) await browser.commands.update({ name, shortcut });
    }
    await browser.storage.local.remove("savedShortcuts");
  }
  return getShortcuts();
}

// Saves the active shortcuts (added to those already saved), then clears them.
async function clearShortcuts(saved) {
  const commands = await browser.commands.getAll();
  const active = commands.filter((c) => c.shortcut && !(c.name in saved));
  for (const c of active) saved[c.name] = c.shortcut;
  await browser.storage.local.set({ savedShortcuts: saved });
  for (const c of active) await browser.commands.update({ name: c.name, shortcut: "" });
}

// An update may add a command with a default shortcut while they are off.
async function keepShortcutsOff() {
  const run = shortcutsOp.then(async () => {
    const { savedShortcuts } = await browser.storage.local.get("savedShortcuts");
    if (savedShortcuts) await clearShortcuts(savedShortcuts);
  });
  shortcutsOp = run.catch(() => {});
  return run;
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
  await menus.removeAll();
  menus.create({
    id: SEARCH_MENU,
    // %s: replaced by the browser with the selected text.
    title: browser.i18n.getMessage("searchOnDeezer"),
    contexts: ["selection"],
    visible: enabled,
  });
}

// Only toggles visibility: removeAll + create from two quick clicks could
// interleave and fail on an existing id. The menu is created at install and
// startup; should it be missing anyway (extension disabled then enabled, if
// Firefox doesn't keep it) and update() reject, create it.
async function setSearchMenu(enabled) {
  await browser.storage.local.set({ searchMenuEnabled: enabled });
  try {
    await menus.update(SEARCH_MENU, { visible: enabled });
  } catch {
    await createSearchMenu();
  }
  return getSearchMenu();
}

// No menus API on Android.
if (menus) {
  browser.runtime.onInstalled.addListener(createSearchMenu);
  browser.runtime.onStartup.addListener(createSearchMenu);
  menus.onClicked.addListener(onSearchMenuClicked);
}

async function onSearchMenuClicked(info, tab) {
  if (info.menuItemId !== SEARCH_MENU) return;
  const query = info.selectionText?.trim();
  if (!query) return;
  // The search tab is a full Deezer page: make sure the remote keeps
  // controlling the current player rather than this new tab.
  const player = await findDeezerTab();
  if (player) await rememberPlayerTab(player.id);
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

// Mirrored in memory: read on every sound change in any tab.
const autoPauseEnabled = storedValue(browser.storage.local, "autoPauseEnabled", false);

async function getAutoPause() {
  return { enabled: await autoPauseEnabled.get() };
}

async function setAutoPause(enabled) {
  await autoPauseEnabled.set(enabled);
  if (!enabled) await autoPaused.set(null);
  return getAutoPause();
}

// { at, tabId }: when and which Deezer tab the auto-pause paused. Only that
// tab is resumed, never another Deezer tab (a search tab, for instance).
const autoPaused = sessionValue("autoPaused");

// Tab events run one after the other: closing a video tab can report
// audible: false and the removal almost together, and both would send "play"
// before Deezer's button updates; the second click would pause again.
let autoPauseOp = Promise.resolve();

function queueAutoPause(fn) {
  autoPauseOp = autoPauseOp.then(fn).catch(() => {});
}

async function onOtherTabSound(tab) {
  if (isDeezerTab(tab) || !(await autoPauseEnabled.get())) return;
  if (isHeard(tab)) {
    // Already paused by us (another tab started first).
    if (await autoPaused.get()) return;
    const deezer = await findDeezerTab();
    if (!deezer || deezer.discarded) return;
    const state = await sendToDeezer(deezer, { type: "getState" });
    if (!state?.playing) return;
    // Sleep timer fading: pause, but don't resume afterwards.
    if (!sleepFading) await autoPaused.set({ at: Date.now(), tabId: deezer.id });
    await sendToDeezer(deezer, { type: "command", action: "pause" });
  } else {
    await resumeIfQuiet();
  }
}

async function resumeIfQuiet() {
  const paused = await autoPaused.get();
  if (!paused) return;
  const audible = await browser.tabs.query({ audible: true });
  if (audible.some((t) => !isDeezerTab(t) && isHeard(t))) return;
  await autoPaused.set(null);
  const deezer = await browser.tabs.get(paused.tabId).catch(() => null);
  if (deezer && isDeezerTab(deezer) && !deezer.discarded) {
    await sendToDeezer(deezer, { type: "command", action: "play" });
  }
}

async function clearAutoPauseIfPlaying(state) {
  if (!state?.playing) return;
  const paused = await autoPaused.get();
  if (paused && Date.now() - paused.at > AUTO_PAUSE_GRACE_MS) await autoPaused.set(null);
}

onTabUpdated((tabId, changeInfo, tab) => queueAutoPause(() => onOtherTabSound(tab)), {
  properties: ["audible", "mutedInfo"],
});
// A closed tab doesn't always report audible: false first. The paused Deezer
// tab closed: nothing left to resume.
browser.tabs.onRemoved.addListener((tabId) =>
  queueAutoPause(async () => {
    if ((await autoPaused.get())?.tabId === tabId) await autoPaused.set(null);
    else await resumeIfQuiet();
  }),
);

// Opens Deezer's queue panel, then brings the tab to the front.
async function showQueue() {
  const { state } = await runCommand("openQueue");
  if (state?.error) return { ...(await getStatus()), state };
  return showTab();
}

// Track change notification, opt-in from the options page (optional
// "notifications" permission). The content script pushes its state about once
// a second while playing: checks are chained so that concurrent pushes don't
// notify the same track twice. The last track is kept in session storage (the
// event page unloads while Deezer is paused) and mirrored in memory, so that
// pushes for the same track cost nothing.
const TRACK_NOTIFICATION = "track";
let trackCheck = Promise.resolve();
const lastTrack = sessionValue("lastTrack");

function onPlayerState(tab, state) {
  trackCheck = trackCheck.then(() => notifyTrackChange(tab, state)).catch(() => {});
}

async function notifyTrackChange(tab, state) {
  if (!state?.available || !state.playing || !state.title) return;
  // The link holds the track ID when known: tells apart two tracks with the
  // same title.
  const track = `${state.title} - ${state.artists.join(", ")} - ${state.link ?? ""}`;
  if (track === (await lastTrack.get())) return;
  await lastTrack.set(track);

  const { notifyTrackChange: enabled = false } = await browser.storage.local.get("notifyTrackChange");
  if (!enabled || !browser.notifications) return;
  // Deezer already on screen: nothing to tell.
  if (tab.active && !tab.hidden && (await browser.windows?.get(tab.windowId))?.focused) return;

  const options = { type: "basic", title: state.title, message: state.artists.join(", ") };
  await browser.notifications.clear(TRACK_NOTIFICATION);
  const fallbackIcon = browser.runtime.getURL(NOTIFICATION_ICON);
  try {
    await browser.notifications.create(TRACK_NOTIFICATION, { ...options, iconUrl: state.cover ?? fallbackIcon });
  } catch {
    // Cover refused as an icon: notify with the extension icon.
    await browser.notifications.create(TRACK_NOTIFICATION, { ...options, iconUrl: fallbackIcon });
  }
}

// The notifications API only exists once the optional permission is granted,
// possibly after this page started (and may be revoked, then granted again).
function onNotificationClicked(id) {
  if (id === TRACK_NOTIFICATION) showTab();
}

function listenNotificationClick() {
  if (!browser.notifications || browser.notifications.onClicked.hasListener(onNotificationClicked)) return;
  browser.notifications.onClicked.addListener(onNotificationClicked);
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
  "remote:getStatus": (msg) => getStatus({ wake: msg.wake ?? true }),
  "remote:command": (msg) => runCommand(msg.action, msg.value),
  "remote:launchHidden": () => launchHidden(),
  "remote:showTab": () => showTab(),
  "remote:hideTab": () => hideTab(),
  "remote:toggleMute": () => toggleMute(),
};

onMessage((message, sender) => {
  // State pushed by the content script (also received by an open popup).
  // About once a second while playing, which keeps the event page loaded
  // during playback: the work done here must stay cheap (memory first).
  if (message?.type === "state" && sender.tab) {
    if (message.state?.playing) rememberPlayerTab(sender.tab.id);
    queueActionTitle(() => updateActionTitle(sender.tab.id, message.state));
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

// No commands API on Android.
if (browser.commands) {
  browser.commands.onCommand.addListener((command) => {
    const entry = COMMANDS[command];
    if (entry) runCommand(...entry);
  });
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === "update" && CAN_SET_SHORTCUTS) keepShortcutsOff();
  });
}
