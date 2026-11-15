import { extractCoverColors } from "./cover-colors.js";
import { t, translatePage } from "../shared/i18n.js";

translatePage();

// Same page for the toolbar popup and the mini-player window.
const detached = new URLSearchParams(location.search).has("detached");
document.documentElement.classList.toggle("detached", detached);

const $ = (id) => document.getElementById(id);

const ui = {
  empty: $("empty"),
  emptyMessage: $("empty-message"),
  spinner: $("spinner"),
  launch: $("launch"),
  player: $("player"),
  cover: $("cover"),
  title: $("title"),
  artists: $("artists"),
  like: $("like"),
  elapsed: $("elapsed"),
  seek: $("seek"),
  duration: $("duration"),
  shuffle: $("shuffle"),
  previous: $("previous"),
  play: $("play"),
  next: $("next"),
  repeat: $("repeat"),
  repeatOne: $("repeat-one"),
  mute: $("mute"),
  volume: $("volume"),
  sleep: $("sleep"),
  sleepMinutes: $("sleep-minutes"),
  detach: $("detach"),
  optionsToggle: $("options-toggle"),
  options: $("options"),
  shortcuts: $("shortcuts"),
  searchMenu: $("search-menu"),
  autoPause: $("auto-pause"),
  share: $("share"),
  queue: $("queue"),
  visibility: $("visibility"),
  autoplayWarning: $("autoplay-warning"),
  autoplayShow: $("autoplay-show"),
  error: $("error"),
};

let current = { tab: null, state: null };
let seeking = false;
// True only after a play click that produced no sound: the autoplay warning
// only shows when the blocking actually got in the way.
let playBlocked = false;

const PLAY_CHECK_DELAY_MS = 1500;

// Volume: read once when the popup opens (it opens the menu in Deezer), then
// sent while dragging, one command at a time.
let volumeRequested = false;
let adjustingVolume = false;
let pendingVolume = null;
let sendingVolume = false;

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Right-hand time: total duration, or remaining time after a click on it
// (remembered, shared with the mini-player).
let showRemaining = false;
browser.storage.local.get("showRemaining").then((stored) => {
  showRemaining = !!stored.showRemaining;
  renderDuration();
});

function renderDuration() {
  const duration = current.state?.duration ?? 0;
  const elapsed = seeking ? Number(ui.seek.value) : (current.state?.elapsed ?? 0);
  ui.duration.textContent = showRemaining ? `-${formatTime(duration - elapsed)}` : formatTime(duration);
  ui.duration.title = showRemaining ? t("showDuration") : t("showRemaining");
}

// Content script control name -> popup elements.
const CONTROL_ELEMENTS = {
  play: ["play"],
  next: ["next"],
  previous: ["previous"],
  shuffle: ["shuffle"],
  repeat: ["repeat"],
  like: ["like"],
  progress: ["seek"],
  volumeButton: ["volume"],
  queue: ["queue"],
};

// Controls Deezer no longer shows: disabled with an explanation, rather than
// an error on click.
function renderMissingControls(missing = []) {
  for (const [name, elements] of Object.entries(CONTROL_ELEMENTS)) {
    const unavailable = missing.includes(name);
    for (const id of elements) {
      const el = ui[id];
      el.classList.toggle("unavailable", unavailable);
      // The volume slider stays disabled until its value is known.
      if (id !== "volume" || unavailable) el.disabled = unavailable;
      if (unavailable) {
        el.dataset.originalTitle ??= el.title;
        el.title = t("controlUnavailable");
      } else if (el.dataset.originalTitle != null) {
        el.title = el.dataset.originalTitle;
        delete el.dataset.originalTitle;
      }
    }
  }
}

function showError(message) {
  ui.error.textContent = message ?? "";
  ui.error.hidden = !message;
}

// Background gradient from the cover, recomputed only when the track changes.
let coloredCover = null;
async function applyCoverColors(url) {
  if (url === coloredCover) return;
  coloredCover = url;
  const root = document.documentElement.style;
  try {
    const colors = url ? await extractCoverColors(url) : null;
    if (coloredCover !== url) return; // Another track arrived meanwhile.
    if (!colors) throw new Error("No cover");
    root.setProperty("--cover-top", colors.top);
    root.setProperty("--cover-bottom", colors.bottom);
  } catch {
    root.removeProperty("--cover-top");
    root.removeProperty("--cover-bottom");
  }
}

function render({ tab, state }) {
  current = { tab, state };
  const ready = tab && state?.available;

  ui.empty.hidden = !!ready;
  ui.player.hidden = !ready;
  if (!ready) {
    ui.emptyMessage.textContent = !tab
      ? t("noDeezerTab")
      : tab.discarded
        ? t("deezerWaking")
        : t("deezerLoading");
    ui.launch.hidden = !!tab;
    ui.spinner.hidden = !tab;
    return;
  }

  ui.cover.src = state.cover ?? "";
  applyCoverColors(state.cover);
  ui.title.textContent = state.title || t("noTitle");
  ui.artists.textContent = state.artists.join(", ");
  ui.play.classList.toggle("playing", state.playing);
  ui.play.title = state.playing ? t("pause") : t("play");
  ui.like.classList.toggle("active", state.liked);
  ui.shuffle.classList.toggle("active", state.shuffle);
  ui.repeat.classList.toggle("active", state.repeat !== "off");
  ui.repeatOne.hidden = state.repeat !== "one";

  if (!seeking) {
    ui.seek.max = String(state.duration);
    ui.seek.value = String(state.elapsed);
    ui.elapsed.textContent = formatTime(state.elapsed);
  }
  renderDuration();
  renderMissingControls(state.missing);
  ui.share.disabled = !state.link;

  // Unblocked meanwhile: click in the Deezer tab or site allowed.
  if (state.autoplay === "allowed") playBlocked = false;
  ui.autoplayWarning.hidden = !playBlocked;

  if (state.volume == null && !volumeRequested) {
    volumeRequested = true;
    command("readVolume");
  }
  if (state.volume != null && !adjustingVolume) {
    ui.volume.value = String(state.volume);
    ui.volume.disabled = false;
  }

  ui.mute.classList.toggle("muted", tab.muted);
  ui.mute.title = tab.muted ? t("unmuteTab") : t("muteTab");
  // The eye shows the current state: crossed out when the tab is hidden.
  ui.visibility.classList.toggle("tab-hidden", tab.hidden);
  ui.visibility.title = tab.hidden ? t("showDeezerTab") : t("hideDeezerTab");
}

async function call(type, extra = {}) {
  try {
    showError(null);
    const result = await browser.runtime.sendMessage({ type, ...extra });
    render(result);
    if (result?.state?.error) showError(result.state.error);
  } catch (err) {
    showError(err.message);
  }
}

const command = (action, value) => call("remote:command", { action, value });

ui.play.addEventListener("click", async () => {
  const wasPlaying = current.state?.playing;
  await command("togglePlay");
  if (wasPlaying) return;
  // Give the sound time to start, then check the tab is actually audible.
  await new Promise((resolve) => setTimeout(resolve, PLAY_CHECK_DELAY_MS));
  const { tab, state } = await browser.runtime.sendMessage({ type: "remote:getStatus" });
  // "unknown" (API missing): no warning rather than a false positive.
  playBlocked = !!tab && !tab.audible && state?.autoplay !== "allowed" && state?.autoplay !== "unknown";
  render({ tab, state });
});
ui.next.addEventListener("click", () => command("next"));
ui.previous.addEventListener("click", () => command("previous"));
ui.shuffle.addEventListener("click", () => command("toggleShuffle"));
ui.repeat.addEventListener("click", () => command("cycleRepeat"));
ui.like.addEventListener("click", () => command("toggleLike"));
ui.mute.addEventListener("click", () => call("remote:toggleMute"));
ui.visibility.addEventListener("click", () =>
  call(current.tab?.hidden ? "remote:showTab" : "remote:hideTab"),
);
// The toolbar popup gets in the way once the Deezer tab is shown; the
// mini-player stays open.
const closePopup = () => detached || window.close();

ui.autoplayShow.addEventListener("click", () => call("remote:showTab").then(closePopup));
ui.title.addEventListener("click", (event) => {
  event.preventDefault();
  call("remote:showTab").then(closePopup);
});

// Mini-player: a small window with the same page. Firefox can't keep it
// always on top. No windows API on Android.
const MINI_PLAYER_URL = browser.runtime.getURL("popup/popup.html?detached");
const MINI_PLAYER_SIZE = { width: 340, height: 500 };

ui.detach.hidden = detached || !browser.windows;
ui.detach.addEventListener("click", async () => {
  // Only one mini-player: focus the existing one.
  const windows = await browser.windows.getAll({ populate: true, windowTypes: ["popup"] });
  const existing = windows.find((w) => w.tabs.some((tab) => tab.url === MINI_PLAYER_URL));
  if (existing) await browser.windows.update(existing.id, { focused: true });
  else await browser.windows.create({ url: MINI_PLAYER_URL, type: "popup", ...MINI_PLAYER_SIZE });
  window.close();
});

ui.launch.addEventListener("click", async () => {
  // Show the loading state right away, without waiting for the tab to be created.
  ui.launch.hidden = true;
  ui.spinner.hidden = false;
  ui.emptyMessage.textContent = t("deezerLoading");
  await call("remote:launchHidden");
  // On failure, render() wasn't called: go back to the initial state.
  if (!current.tab) {
    ui.launch.hidden = false;
    ui.spinner.hidden = true;
    ui.emptyMessage.textContent = t("noDeezerTab");
  }
});

async function flushVolume() {
  if (sendingVolume) return;
  sendingVolume = true;
  while (pendingVolume != null) {
    const value = pendingVolume;
    pendingVolume = null;
    await command("setVolume", value);
  }
  sendingVolume = false;
}

ui.volume.addEventListener("input", () => {
  adjustingVolume = true;
  pendingVolume = Number(ui.volume.value);
  flushVolume();
});
ui.volume.addEventListener("change", () => {
  adjustingVolume = false;
});

// Mouse wheel on the remote: volume up / down. Not over the settings row and
// the autoplay warning, so the page can still scroll (mini-player). Touchpads
// send many small pixel deltas: accumulate them into notch-sized steps.
const WHEEL_VOLUME_STEP = 5;
const WHEEL_PIXELS_PER_STEP = 50;
const WHEEL_SETTLE_MS = 400;
let wheelTimer = null;
let wheelPixels = 0;

function wheelSteps(event) {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return -Math.sign(event.deltaY);
  wheelPixels += event.deltaY;
  const steps = Math.trunc(wheelPixels / WHEEL_PIXELS_PER_STEP);
  wheelPixels -= steps * WHEEL_PIXELS_PER_STEP;
  return -steps;
}

ui.player.addEventListener(
  "wheel",
  (event) => {
    if (ui.volume.disabled || !event.deltaY) return;
    if (event.target.closest("#options, #autoplay-warning")) return;
    event.preventDefault();
    const steps = wheelSteps(event);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      adjustingVolume = false;
      wheelPixels = 0;
    }, WHEEL_SETTLE_MS);
    if (!steps) return;
    const value = Math.max(0, Math.min(100, Number(ui.volume.value) + steps * WHEEL_VOLUME_STEP));
    ui.volume.value = String(value);
    // Same path as dragging the slider: one command at a time, last value wins.
    adjustingVolume = true;
    pendingVolume = value;
    flushVolume();
  },
  { passive: false },
);

// Settings row: folded by default in the toolbar popup to keep it small, the
// choice is remembered. The mini-player has room: always shown, at the bottom
// of the window, without the options button.
function setOptionsShown(shown) {
  ui.options.hidden = !shown;
  ui.optionsToggle.setAttribute("aria-expanded", String(shown));
  ui.optionsToggle.title = shown ? t("hideOptions") : t("showOptions");
}
if (detached) {
  ui.optionsToggle.hidden = true;
  ui.options.hidden = false;
} else {
  browser.storage.local.get("expanded").then(({ expanded = false }) => setOptionsShown(expanded));
}
ui.optionsToggle.addEventListener("click", () => {
  const expanded = ui.options.hidden;
  setOptionsShown(expanded);
  browser.storage.local.set({ expanded }).catch(() => {});
});

// On/off buttons for a background setting (keyboard shortcuts, search menu,
// auto-pause). Kept in sync when the setting changes elsewhere (toolbar popup
// vs mini-player) through its storage key. Disabled while a change is running.
function setupToggle(button, { get, set, key, titleOn, titleOff }) {
  if (button.hidden) return;
  const render = ({ enabled }) => {
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.title = enabled ? t(titleOn) : t(titleOff);
  };
  const refresh = () =>
    browser.runtime
      .sendMessage({ type: get })
      .then(render)
      .catch((err) => showError(err.message));
  refresh();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && key in changes) refresh();
  });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const enabled = !button.classList.contains("active");
      render(await browser.runtime.sendMessage({ type: set, enabled }));
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  });
}

// No keyboard shortcuts nor context menus on Android.
ui.shortcuts.hidden = !browser.commands;
ui.searchMenu.hidden = !browser.menus;
setupToggle(ui.shortcuts, {
  get: "remote:getShortcuts",
  set: "remote:setShortcuts",
  key: "savedShortcuts",
  titleOn: "shortcutsOn",
  titleOff: "shortcutsOff",
});
setupToggle(ui.searchMenu, {
  get: "remote:getSearchMenu",
  set: "remote:setSearchMenu",
  key: "searchMenuEnabled",
  titleOn: "searchMenuOn",
  titleOff: "searchMenuOff",
});
setupToggle(ui.autoPause, {
  get: "remote:getAutoPause",
  set: "remote:setAutoPause",
  key: "autoPauseEnabled",
  titleOn: "autoPauseOn",
  titleOff: "autoPauseOff",
});

const COPIED_FEEDBACK_MS = 1500;
ui.share.addEventListener("click", async () => {
  if (!current.state?.link) return;
  try {
    await navigator.clipboard.writeText(current.state.link);
    ui.share.classList.add("copied");
    ui.share.title = t("linkCopied");
    setTimeout(() => {
      ui.share.classList.remove("copied");
      ui.share.title = t("copyLink");
    }, COPIED_FEEDBACK_MS);
  } catch (err) {
    showError(err.message);
  }
});

ui.queue.addEventListener("click", async () => {
  await call("remote:showQueue");
  if (!current.state?.error) closePopup();
});

ui.seek.addEventListener("input", () => {
  seeking = true;
  ui.elapsed.textContent = formatTime(Number(ui.seek.value));
  renderDuration();
});

ui.duration.addEventListener("click", () => {
  showRemaining = !showRemaining;
  renderDuration();
  browser.storage.local.set({ showRemaining }).catch(() => {});
});
ui.seek.addEventListener("change", async () => {
  await command("seek", Number(ui.seek.value));
  seeking = false;
});

// Sleep timer: each click moves to the next duration, after the last one it
// turns off. The background owns the timer (alarm), the popup only shows it.
const SLEEP_DURATIONS = [15, 30, 60];
let sleepEnd = null;
let sleepDuration = 0;

function renderSleepTimer() {
  const remaining = sleepEnd ? Math.ceil((sleepEnd - Date.now()) / 60000) : 0;
  const on = remaining > 0;
  if (!on) sleepDuration = 0;
  ui.sleep.classList.toggle("active", on);
  ui.sleepMinutes.hidden = !on;
  ui.sleepMinutes.textContent = on ? String(remaining) : "";
  ui.sleep.title = on ? t("sleepTimerOn", String(remaining)) : t("sleepTimerOff");
}

async function setSleepTimer(minutes) {
  try {
    const { end } = await browser.runtime.sendMessage({ type: "remote:setSleepTimer", minutes });
    sleepEnd = end;
    sleepDuration = minutes;
  } catch (err) {
    showError(err.message);
  }
  renderSleepTimer();
}

ui.sleep.addEventListener("click", () => {
  const next = SLEEP_DURATIONS.find((d) => d > sleepDuration) ?? 0;
  setSleepTimer(next);
});

// Also re-read periodically: the timer may be changed from another popup
// (mini-player open) or expire.
async function loadSleepTimer() {
  try {
    const { end } = await browser.runtime.sendMessage({ type: "remote:getSleepTimer" });
    if (end === sleepEnd) return;
    sleepEnd = end;
    // Timer started elsewhere: resume the cycle from the closest duration.
    const remaining = end ? (end - Date.now()) / 60000 : 0;
    sleepDuration = remaining > 0 ? (SLEEP_DURATIONS.find((d) => d >= remaining) ?? 0) : 0;
  } catch (err) {
    showError(err.message);
  } finally {
    renderSleepTimer();
  }
}
loadSleepTimer();
setInterval(loadSleepTimer, 10000);

// Full refresh (tab info included), at most one at a time. Not through call():
// it would clear an error the user hasn't read yet.
let refreshing = null;
function refreshStatus() {
  refreshing ??= browser.runtime
    .sendMessage({ type: "remote:getStatus" })
    .then(render)
    .catch(() => {
      // Background unavailable: the next push retries.
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

// Updates pushed by the content script of the tracked Deezer tab.
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "state") return;
  // Another Deezer tab (tracked tab closed, new one opened…), or tab launched
  // or woken from the popup: let the background pick the tab again.
  if (!current.tab || sender.tab?.id !== current.tab.id || !current.state?.available) {
    refreshStatus();
    return;
  }
  render({ tab: current.tab, state: message.state });
});

// Tab info (hidden, muted) changed outside this page, e.g. from the toolbar
// popup while the mini-player is open, or tracked tab closed.
browser.tabs.onUpdated.addListener(
  (tabId) => {
    if (tabId === current.tab?.id) refreshStatus();
  },
  { properties: ["hidden", "mutedInfo", "discarded"] },
);
browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === current.tab?.id) refreshStatus();
});

call("remote:getStatus");
