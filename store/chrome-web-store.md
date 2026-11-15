# Chrome Web Store listing

Text to paste in the Chrome Web Store developer dashboard. Upload the zip made by `npm run build:chrome` (`dist/remote-for-deezer-chrome-<version>.zip`).

## Store listing

- **Name**: Remote for Deezer (from `_locales`)
- **Category**: Entertainment (or Productivity › Tools)
- **Language**: English, French
- **Icon**: `store/icon-128.png`
- **Screenshots** (required, at least one, 1280×800 or 640×400): popup over a page, mini-player, options row.
- **Small promo tile** (optional, 440×280).

### Description (English)

> Control the Deezer web player from any tab.
>
> - Popup remote: cover art, track info, seekable progress bar, play/pause, previous/next, shuffle, repeat, Favourite tracks, volume (also with the mouse wheel), tab mute.
> - Mini-player in its own small window.
> - Sleep timer (15, 30 or 60 minutes) with a volume fade-out.
> - Auto-pause (opt-in): Deezer pauses while another tab plays sound, and resumes afterwards.
> - "Search on Deezer" in the context menu of selected text.
> - Track change notifications (opt-in).
> - Keyboard shortcuts, working from any tab (chrome://extensions/shortcuts).
>
> You need to be logged in to deezer.com in a tab: the extension drives the Deezer web player, it doesn't play music by itself.
>
> Unofficial project, not affiliated with, endorsed by, or sponsored by Deezer. "Deezer" is a trademark of its respective owner.

### Description (français)

> Contrôle le lecteur web Deezer depuis n'importe quel onglet.
>
> - Télécommande dans le popup : pochette, titre, barre de progression, lecture/pause, précédent/suivant, aléatoire, répétition, Coups de cœur, volume (aussi à la molette), mise en sourdine de l'onglet.
> - Mini-lecteur dans sa propre petite fenêtre.
> - Minuterie de mise en veille (15, 30 ou 60 minutes) avec baisse progressive du volume.
> - Pause automatique (à activer) : Deezer se met en pause quand un autre onglet joue du son, et reprend ensuite.
> - « Rechercher sur Deezer » dans le menu contextuel du texte sélectionné.
> - Notifications au changement de titre (à activer).
> - Raccourcis clavier, depuis n'importe quel onglet (chrome://extensions/shortcuts).
>
> Il faut être connecté à deezer.com dans un onglet : l'extension pilote le lecteur web Deezer, elle ne lit pas la musique elle-même.
>
> Projet non officiel, sans lien avec Deezer. « Deezer » est une marque de son propriétaire.

## Privacy practices

**Single purpose**: control the Deezer web player (open in a tab of the browser) from a toolbar popup, a mini-player window and keyboard shortcuts.

**Permission justifications**:

| Permission | Justification |
|---|---|
| `tabs` | Find the Deezer tab among open tabs and read its state (muted, playing sound, asleep) to show it in the remote; with the opt-in auto-pause, detect other tabs starting or stopping sound. |
| `scripting` | Re-inject the controller script into an already open Deezer tab that doesn't have it (for instance after the extension was updated). |
| `storage` | Save the user's settings and, for the browser session only, which Deezer tab is the player and the sleep timer / auto-pause state. |
| `alarms` | Run the sleep timer even after Chrome has stopped the extension's service worker. |
| `contextMenus` | Add "Search on Deezer" to the context menu of selected text (can be turned off). |
| `notifications` (optional) | Track change notifications, only requested when the user turns them on in the options. |
| Host permission `*://www.deezer.com/*` | Read the Deezer player state (title, artists, progress) and click its controls. |

**Remote code**: No, all the code is in the package.

**Data usage**: the extension collects no user data and sends nothing to any server. Tick no data type. Certify that data isn't sold, isn't used for unrelated purposes and isn't used for creditworthiness.

**Privacy policy URL**: the *Privacy* section of the README (`https://github.com/rafyb/deezer-firefox-addon#privacy`).
