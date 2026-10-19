import { extractCoverColors } from "./cover-colors.js";
import { t, translatePage } from "./i18n.js";

translatePage();

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
  ui.duration.textContent = formatTime(state.duration);

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
ui.autoplayShow.addEventListener("click", () => call("remote:showTab").then(() => window.close()));
ui.title.addEventListener("click", (event) => {
  event.preventDefault();
  call("remote:showTab").then(() => window.close());
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

ui.seek.addEventListener("input", () => {
  seeking = true;
  ui.elapsed.textContent = formatTime(Number(ui.seek.value));
});
ui.seek.addEventListener("change", async () => {
  await command("seek", Number(ui.seek.value));
  seeking = false;
});

// Updates pushed by the content script of the tracked Deezer tab.
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "state") return;
  if (current.tab && sender.tab?.id !== current.tab.id) return;
  if (!current.tab || !current.state?.available) {
    // Tab launched or woken from the popup: refresh its tab info too.
    call("remote:getStatus");
    return;
  }
  render({ tab: current.tab, state: message.state });
});

call("remote:getStatus");
