import { t, translatePage } from "../shared/i18n.js";

translatePage();

// Notifications are an optional permission: only asked for when the user turns
// the option on, so the default install keeps a short permission list.
const NOTIFICATIONS = { permissions: ["notifications"] };

const checkbox = document.getElementById("notify-track-change");
const error = document.getElementById("error");

async function load() {
  const { notifyTrackChange = false } = await browser.storage.local.get("notifyTrackChange");
  checkbox.checked = notifyTrackChange && (await browser.permissions.contains(NOTIFICATIONS));
}

checkbox.addEventListener("change", async () => {
  error.hidden = true;
  try {
    // permissions.request() must run first in the click handler (user gesture).
    if (checkbox.checked && !(await browser.permissions.request(NOTIFICATIONS))) {
      checkbox.checked = false;
      error.textContent = t("optionPermissionDenied");
      error.hidden = false;
    }
    await browser.storage.local.set({ notifyTrackChange: checkbox.checked });
    // Option off: give the permission back, it's only needed for this option.
    if (!checkbox.checked) await browser.permissions.remove(NOTIFICATIONS);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

load();
