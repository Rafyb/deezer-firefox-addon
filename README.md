# Remote for Deezer

A Firefox extension to control the Deezer web player from any tab — or with Deezer running in a hidden tab, out of the way.

> **Unofficial project.** Remote for Deezer is not affiliated with, endorsed by, or sponsored by Deezer. "Deezer" is a trademark of its respective owner.

## Features

- **Popup remote**: cover art and track info on a background gradient taken from the cover colors, seekable progress bar (click the duration to show the remaining time), play/pause, previous/next, shuffle, repeat, Favourite tracks, volume (also with the mouse wheel over the remote), tab mute. Icons in the top-right corner: open the mini-player, show/hide the Deezer tab, copy the track link. Next to the heart, the queue button shows the queue in the Deezer tab. The gear at the bottom left shows the *Options* row (always shown at the bottom of the mini-player window): sleep timer, and on/off toggles for keyboard shortcuts, the "Search on Deezer" menu and auto-pause.
- **Search on Deezer**: right-click selected text on any page → *Search "…" on Deezer* opens the Deezer search in a new tab (a new tab so the music keeps playing). Can be turned off from the popup.
- **Auto-pause** *(opt-in)*: Deezer pauses when another tab starts playing sound (a video, a call) and resumes when it stops. It only resumes what it paused itself.
- **Toolbar tooltip**: hover the toolbar icon to see the current track.
- **Mini-player**: the arrow icon in the top-right corner of the popup opens the remote in its own small window, which stays open. Firefox can't keep it always on top.
- **Track notifications** *(opt-in)*: a system notification when the track changes, unless Deezer is on screen. Turn it on in `about:addons` → Remote for Deezer → *Options*.
- **Sleep timer**: the moon icon in the popup's options pauses playback after 15, 30 or 60 minutes, with a short volume fade-out first. The volume is restored for the next play.
- **Background mode**: open Deezer in a hidden tab (Firefox `tabHide` API) and toggle its visibility with the eye icon (top-right corner of the popup).
- **Keyboard shortcuts**, working from any tab:

  | Action | Default shortcut |
  |---|---|
  | Play / pause | `Alt+Shift+P` |
  | Next track | `Alt+Shift+N` |
  | Previous track | `Alt+Shift+B` |
  | Volume up / down (10 %) | `Alt+Shift+Up` / `Alt+Shift+Down` |
  | Add to / remove from Favourite tracks | *(unassigned)* |

  Change them in `about:addons` → ⚙️ → *Manage Extension Shortcuts*. Turn them all off (and back on, with your choices kept) from the keyboard button in the popup's options.
- **Media keys and system media controls**: handled natively by the Deezer web player (Media Session API), even in a hidden tab: keyboard media keys, headset buttons and the Windows media overlay work without extra setup.
- **Sleeping tabs**: Deezer tabs that Firefox restored without loading are woken up automatically.
- **Languages**: English by default, French when Firefox is in French.

## Installation

Remote for Deezer is not published on [addons.mozilla.org](https://addons.mozilla.org) yet. Until then, install it from source:

1. Clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select `src/manifest.json`.

Temporary add-ons are removed when Firefox restarts. Requires Firefox 140 or later.

## Usage

1. Log in to [deezer.com](https://www.deezer.com) in Firefox.
2. Click the toolbar icon to open the remote. If no Deezer tab is open, click **Open Deezer in the background**.
3. Control playback from the popup or with the keyboard shortcuts.

## Known limitations

- **Autoplay blocking**: Firefox blocks sound in a tab until you have clicked inside it. Simulated clicks from an extension don't count. If the popup warns that sound is blocked, allow it once for deezer.com: in the Deezer tab, click the icon left of the address bar → *Autoplay* → *Allow Audio and Video*.
- **First play in a hidden tab**: Firefox also holds back sound in tabs that have never been in the foreground. When needed, the extension shows the Deezer tab for a split second before the first play. You may see a short flash, and the popup may close.
- **Deezer UI changes**: the extension drives the Deezer web player through its page structure. A Deezer redesign can break some controls until the selectors are updated; the popup greys out the controls it can no longer find (see [Contributing](CONTRIBUTING.md)).
- **No playback without the Deezer web player**: Deezer's public API only provides 30-second previews, so the extension always relies on an open (possibly hidden) Deezer tab.

## Privacy

Remote for Deezer collects no data and has no server. It only talks to the Deezer tab open in your browser.

| Permission | Why |
|---|---|
| `tabs` | Find the Deezer tab and read its state (muted, hidden, playing sound). |
| `tabHide` | Hide the Deezer tab in background mode. |
| `scripting` | Re-inject the controller into a Deezer tab that lost it. |
| `alarms` | Trigger the sleep timer, even if Firefox has unloaded the extension's background page meanwhile. |
| `storage` | Remember your settings (including your shortcuts while they are turned off), and, for the current session only, which tabs have already been shown (see *Known limitations*). |
| `menus` | Add *Search on Deezer* to the context menu of selected text. |
| `notifications` *(optional)* | Track change notifications. Only requested when you turn them on in the options. |
| `www.deezer.com` | Read the player state and click its controls. |

## Development

```bash
npm install
npm start      # launches a test Firefox profile with the extension and deezer.com
npm run lint   # web-ext lint (same checks as addons.mozilla.org)
npm run build  # packages the extension into dist/
```

`npm start` uses a fresh Firefox profile, so you need to log in to Deezer again there.

### Project structure

```
src/
├── manifest.json        Manifest V3 (Firefox ≥ 140)
├── background.js        Routes popup/shortcut commands to the Deezer tab, manages the hidden tab
├── content/deezer.js    Reads the player state and acts on the Deezer page (all DOM selectors live here)
├── popup/               Remote UI, also used as the mini-player window (popup.html/css/js, cover colors)
├── options/             Options page (track notifications)
├── shared/              Code shared by the popup and the options page (i18n helper)
├── _locales/            Translations (en default, fr)
└── icons/
```

Notes on the Deezer page structure and the Firefox quirks the extension works around are in [.ai/docs/deezer-dom.md](.ai/docs/deezer-dom.md) (in French).

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
