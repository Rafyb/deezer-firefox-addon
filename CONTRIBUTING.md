# Contributing

Thanks for helping! Bug reports, fixes and translations are all welcome.

## Reporting a bug

Open an issue with the **Bug report** template. Please include your Firefox version, the extension version and whether the Deezer tab was visible, hidden or sleeping. Most bugs come from a change in the Deezer web player, so a short description of what the Deezer page shows helps a lot.

## Development setup

Requirements: Node.js 20+ and Firefox 128+.

```bash
npm install
npm start      # test Firefox profile with the extension loaded and auto-reload
npm run lint   # must pass before opening a pull request
```

You can also load `src/manifest.json` from `about:debugging` in your everyday Firefox profile, where you are already logged in to Deezer.

There is no build step: the files in `src/` are what ships.

## When Deezer changes its UI

All Deezer DOM selectors are in the `SELECTORS` object at the top of [`src/content/deezer.js`](src/content/deezer.js). Most breakages are fixed there. Deezer's player uses stable `data-testid` attributes: prefer them over CSS classes.

## Translations

Strings live in `src/_locales/<language>/messages.json`. To add a language, copy `src/_locales/en/messages.json` to a new folder named after the language code and translate the `message` values. In the popup HTML, strings are applied through the `data-i18n`, `data-i18n-title` and `data-i18n-aria-label` attributes (see `src/popup/i18n.js`).

## Pull requests

- Keep changes focused, one topic per pull request.
- Run `npm run lint` and test in Firefox (visible tab and hidden tab) before submitting.
- Add an entry to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.
- Code comments are in English and explain *why*, not *what*.
