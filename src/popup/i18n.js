// Translations from _locales/: English by default, French when Firefox is in
// French (browser.i18n picks the language, nothing to detect here).

export const t = (key, ...substitutions) => browser.i18n.getMessage(key, substitutions);

// Fills the marked elements in the HTML:
// data-i18n -> text, data-i18n-title -> title, data-i18n-aria-label -> aria-label.
export function translatePage(root = document) {
  document.documentElement.lang = browser.i18n.getUILanguage();
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
}
