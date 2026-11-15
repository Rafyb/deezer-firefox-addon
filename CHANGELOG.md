# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-15

### Added

- Keyboard shortcuts to turn the Deezer volume up and down (`Alt+Shift+Up` / `Alt+Shift+Down`, 10 % steps).
- Sleep timer in the popup (15, 30 or 60 minutes), with a volume fade-out before pausing. Requires the new `alarms` permission.
- Mini-player: open the remote in its own window from the popup.
- Opt-in track change notifications, from the new options page (optional `notifications` permission).
- Click the track duration to show the remaining time.
- Mouse wheel on the remote changes the volume (not over the Options row, so the mini-player can still scroll).
- Toolbar icon tooltip shows the current track.
- Opt-in auto-pause: Deezer pauses while another tab plays sound, and resumes afterwards.
- "Search on Deezer" in the context menu of selected text, can be turned off from the popup (new `menus` permission).
- Popup layout: mini-player, show/hide tab and copy link in the top-right corner; queue button next to the heart; a gear button shows the Options row (sleep timer, keyboard shortcuts, search menu, auto-pause).

### Changed

- The eye (show/hide the Deezer tab) moved to the top-right corner of the popup.
- Controls the extension can no longer find in the Deezer page are greyed out in the popup, instead of showing an error when clicked.

## [0.1.1] - 2026-10-19

### Fixed

- Require Firefox 140 (Firefox for Android 142), the first versions supporting the `data_collection_permissions` manifest key.

## [0.1.0] - 2026-10-19

First public release.

### Added

- Popup remote: cover, title, artists, seekable progress, play/pause, previous/next, shuffle, repeat, Favourite tracks, volume and tab mute.
- Background gradient based on the cover colors.
- Background mode: open Deezer in a hidden tab, show or hide it from the popup.
- Keyboard shortcuts for play/pause, next and previous track, and Favourite tracks.
- Automatic wake-up of sleeping Deezer tabs.
- Warning when Firefox blocks autoplay, and a one-time workaround for tabs that were never shown.
- English and French translations.

[Unreleased]: https://github.com/Rafyb/deezer-firefox-addon/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Rafyb/deezer-firefox-addon/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Rafyb/deezer-firefox-addon/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Rafyb/deezer-firefox-addon/releases/tag/v0.1.0
