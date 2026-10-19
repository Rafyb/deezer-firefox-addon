// Content script injected into www.deezer.com: reads the player state and
// runs the commands sent by the background.
// All Deezer DOM selectors live here: this is the only file to update when
// Deezer changes its UI.

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
  };
  // The volume slider is in a popover rendered outside #page_player, and only
  // while the menu is open (on button hover).
  const VOLUME_BAR = '[data-testid="volume_menu_bar"]';

  // Cached volume (0-100): reading it requires opening the menu, which
  // readState() can't do without looping with the MutationObserver.
  let volume = null;

  // Error messages shown in the popup, in Firefox's language.
  const t = (key, ...substitutions) => browser.i18n.getMessage(key, substitutions);

  function q(name) {
    const player = document.querySelector(SELECTORS.player);
    return player ? player.querySelector(SELECTORS[name]) : null;
  }

  // data-testid suffix: "play_button_pause" -> "pause".
  function testIdSuffix(el, prefix) {
    return el?.dataset.testid?.slice(prefix.length) ?? null;
  }

  function readState() {
    const player = document.querySelector(SELECTORS.player);
    if (!player) return { available: false };

    const progress = q("progress");
    return {
      available: true,
      title: q("title")?.textContent.trim() ?? "",
      link: q("titleLink")?.href ?? null,
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
    setVolume: (value) => withVolumeBar((bar) => setSlider(bar, value)),
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  browser.runtime.onMessage.addListener(async (message) => {
    if (message?.type === "getState") return readState();
    if (message?.type === "command") {
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
    return undefined;
  });

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

  // The player renders after the app loads: wait for it to appear.
  if (!observePlayer()) {
    const bootstrap = new MutationObserver(() => {
      if (observePlayer()) bootstrap.disconnect();
    });
    bootstrap.observe(document.body, { childList: true, subtree: true });
  }
}
