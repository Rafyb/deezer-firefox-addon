// Content script injected into www.deezer.com: reads the player state and
// runs the commands sent by the background.
// All Deezer DOM selectors live here: this is the only file to update when
// Deezer changes its UI.

// Chrome: same API as `chrome` (`browser` only in recent versions).
globalThis.browser ??= globalThis.chrome;

// Guard against double injection (manifest + scripting.executeScript).
if (!window.__remoteForDeezerLoaded) {
  window.__remoteForDeezerLoaded = true;
  setup();
}

function setup() {
  const SELECTORS = {
    player: "#page_player",
    title: '[data-testid="item_title"]',
    titleLink: '[data-testid="item_title"] a',
    artists: '[data-testid="item_subtitle"] a',
    cover: '[data-testid="item_cover"] img',
    play: '[data-testid^="play_button_"]',
    next: '[data-testid="next_track_button"]',
    previous: '[data-testid="previous_track_button"]',
    shuffle: '[data-testid^="shuffle_play_button_"]',
    repeat: '[data-testid^="repeat_button_"]',
    like: '[data-testid^="add_to_favorite_button_"]',
    progress: '[data-testid="progress_bar"]',
    volumeButton: '[data-testid^="volume_button_"]',
    queue: '[data-testid="queue_list_button"]',
  };
  // Queue panel, present only while it is open.
  const QUEUE_PANEL = '[data-testid="queue_content"]';
  const CONTROLS = ["play", "next", "previous", "shuffle", "repeat", "like", "progress", "volumeButton", "queue"];
  // The volume slider is in a popover rendered outside #page_player, and only
  // while the menu is open (on button hover).
  const VOLUME_BAR = '[data-testid="volume_menu_bar"]';

  // Cached volume (0-100): reading it requires opening the menu, which
  // readState() can't do without looping with the MutationObserver.
  let volume = null;

  // Error messages shown in the popup, in the browser's language.
  const t = (key, ...substitutions) => browser.i18n.getMessage(key, substitutions);

  function q(name) {
    const player = document.querySelector(SELECTORS.player);
    return player ? player.querySelector(SELECTORS[name]) : null;
  }

  // data-testid suffix: "play_button_pause" -> "pause".
  function testIdSuffix(el, prefix) {
    return el?.dataset.testid?.slice(prefix.length) ?? null;
  }

  // Link to the track itself: the title link in the player leads to the album.
  // The track ID isn't in the DOM; Deezer's legacy player global exposes it.
  // Page internals, so anything unexpected falls back to the album link.
  function trackLink() {
    try {
      const id = window.wrappedJSObject.dzPlayer?.getSongId?.();
      if (/^\d+$/.test(String(id))) return `https://www.deezer.com/track/${id}`;
    } catch {
      // Global missing or changed.
    }
    return q("titleLink")?.href ?? null;
  }

  function readState() {
    const player = document.querySelector(SELECTORS.player);
    if (!player) return { available: false };

    const progress = q("progress");
    return {
      available: true,
      title: q("title")?.textContent.trim() ?? "",
      link: trackLink(),
      artists: [...player.querySelectorAll(SELECTORS.artists)].map((a) => a.textContent.trim()),
      cover: q("cover")?.src ?? null,
      // The button shows the available action: "pause" means it's playing.
      playing: testIdSuffix(q("play"), "play_button_") === "pause",
      shuffle: testIdSuffix(q("shuffle"), "shuffle_play_button_") === "on",
      // Deezer cycles "off" -> "all" -> "single".
      repeat: { all: "all", single: "one" }[testIdSuffix(q("repeat"), "repeat_button_")] ?? "off",
      liked: testIdSuffix(q("like"), "add_to_favorite_button_") === "on",
      // "allowed" | "allowed-muted" | "disallowed": sound is blocked until the
      // user clicks in the page or allows autoplay for the site.
      autoplay: navigator.getAutoplayPolicy?.("mediaelement") ?? "unknown",
      elapsed: progress ? Number(progress.getAttribute("aria-valuenow")) || 0 : 0,
      duration: progress ? Number(progress.max) || 0 : 0,
      volume,
      // Controls missing from the page (Deezer redesign): the popup disables
      // them instead of failing on click.
      missing: CONTROLS.filter((name) => !q(name)),
    };
  }

  function click(name) {
    const el = q(name);
    if (!el) throw new Error(t("errorElementNotFound", name));
    el.click();
  }

  // Deezer's sliders (React) only commit the value on mouse release:
  // simulate mousedown -> input -> mouseup.
  function setSlider(bar, value) {
    bar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // Native setter: bypasses React's value tracking, otherwise onChange ignores the change.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(bar, String(Math.max(Number(bar.min), Math.min(Number(bar.max), value))));
    bar.dispatchEvent(new Event("input", { bubbles: true }));
    bar.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }

  function seek(seconds) {
    const bar = q("progress");
    if (!bar) throw new Error(t("errorProgressNotFound"));
    setSlider(bar, seconds);
  }

  // MutationObserver rather than a setTimeout loop: Firefox throttles timers in
  // background tabs (1 s minimum), which made the wait time out.
  function waitForElement(selector, timeoutMs) {
    const existing = document.querySelector(selector);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(t("errorVolumeSliderNotFound")));
      }, timeoutMs);
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Opens the volume menu long enough to use its slider, then closes it.
  async function withVolumeBar(fn) {
    const button = q("volumeButton");
    if (!button) throw new Error(t("errorVolumeButtonNotFound"));
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    try {
      const bar = await waitForElement(VOLUME_BAR, 5000);
      fn(bar);
      volume = Number(bar.value);
    } finally {
      button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    }
  }

  const setVolume = (value) => withVolumeBar((bar) => setSlider(bar, value));

  // Sleep timer: lowers the volume step by step, pauses, then restores the
  // volume so the next play isn't silent. One step per second: Firefox
  // throttles timers in background tabs to 1 s anyway. The volume menu is
  // reopened at each step rather than held open, in case Deezer closes it.
  // The fade is only a nicety: if the volume menu can't be used, pause anyway.
  const FADE_STEPS = 15;
  const FADE_STEP_MS = 1000;

  // Running fade. Cancelled by a new sleep timer (keeps playing, volume
  // restored) or by a volume change from the user (keeps their volume).
  let fade = null;

  function cancelFade({ restore }) {
    if (!fade) return;
    fade.cancelled = true;
    fade.restore = restore;
  }

  async function fadeOutAndPause() {
    if (!readState().playing || fade) return;
    const current = (fade = { cancelled: false, restore: true });
    let initial = null;
    try {
      try {
        await withVolumeBar(() => {});
        initial = volume;
        for (let i = FADE_STEPS - 1; i >= 0 && !current.cancelled; i--) {
          // Paused by the user meanwhile: stop fading.
          if (!readState().playing) return;
          await setVolume(Math.round((initial * i) / FADE_STEPS));
          schedulePush();
          await wait(FADE_STEP_MS);
        }
      } catch {
        // Volume menu unavailable: pause without fading.
      }
      if (current.cancelled) return;
      if (readState().playing) click("play");
      // Let the pause take effect before turning the sound back up.
      await wait(500);
    } finally {
      fade = null;
      if (initial != null && current.restore) {
        try {
          await setVolume(initial);
          schedulePush();
        } catch {
          // Volume menu unavailable: nothing to restore.
        }
      }
    }
  }

  // Volume set by the user: wins over a running fade.
  function userVolume(fn) {
    cancelFade({ restore: false });
    return fn();
  }

  const ACTIONS = {
    togglePlay: () => click("play"),
    play: () => readState().playing || click("play"),
    pause: () => readState().playing && click("play"),
    next: () => click("next"),
    previous: () => click("previous"),
    toggleShuffle: () => click("shuffle"),
    cycleRepeat: () => click("repeat"),
    toggleLike: () => click("like"),
    seek: (value) => seek(value),
    readVolume: () => withVolumeBar(() => {}),
    setVolume: (value) => userVolume(() => setVolume(value)),
    fadeOutAndPause: () => fadeOutAndPause(),
    cancelFade: () => cancelFade({ restore: true }),
    // Toggle button: only click when the panel isn't already open.
    openQueue: () => document.querySelector(QUEUE_PANEL) || click("queue"),
    // Keyboard shortcuts: relative to the slider's current value, the cache
    // may be stale (volume changed in the Deezer page).
    changeVolume: async (delta) => {
      await userVolume(() => withVolumeBar((bar) => setSlider(bar, Number(bar.value) + delta)));
      // The slider lives outside #page_player: the observer doesn't see the
      // change, so tell an open popup.
      schedulePush();
    },
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Replies through sendResponse: returning a promise from the listener
  // doesn't work in older Chrome versions.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "getState") {
      sendResponse(readState());
      return false;
    }
    if (message?.type !== "command") return false;
    runAction(message).then(sendResponse);
    return true;
  });

  async function runAction(message) {
    // A failed action returns the current state with the error: rejecting the
    // promise would make the background think the tab isn't ready.
    try {
      const action = ACTIONS[message.action];
      if (!action) throw new Error(t("errorUnknownAction", message.action));
      await action(message.value);
    } catch (err) {
      return { ...readState(), error: err.message };
    }
    // Let React update the DOM before returning the state.
    await wait(150);
    return readState();
  }

  // Push the state to the popup when the player changes (track, buttons, progress).
  let pushTimer = null;
  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      browser.runtime.sendMessage({ type: "state", state: readState() }).catch(() => {
        // No popup open: nothing to do.
      });
    }, 250);
  }

  function observePlayer() {
    const player = document.querySelector(SELECTORS.player);
    if (!player) return false;
    new MutationObserver(schedulePush).observe(player, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-testid", "aria-valuenow", "src"],
    });
    schedulePush();
    return true;
  }

  // Leaving the page (other site, reload): the toolbar tooltip and an open
  // popup stop showing this track. Best effort, the page is going away.
  window.addEventListener("pagehide", () => {
    clearTimeout(pushTimer);
    pushTimer = null;
    browser.runtime.sendMessage({ type: "state", state: { available: false } }).catch(() => {});
  });
  // Back from the back/forward cache: tell them again.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) schedulePush();
  });

  // The player renders after the app loads: wait for it to appear.
  if (!observePlayer()) {
    const bootstrap = new MutationObserver(() => {
      if (observePlayer()) bootstrap.disconnect();
    });
    bootstrap.observe(document.body, { childList: true, subtree: true });
  }
}
