# Interface DOM du lecteur Deezer

Relevé le 2026-10-19 sur www.deezer.com/fr. Tous les sélecteurs vivent dans `SELECTORS` de `src/content/deezer.js` : c'est le seul endroit à mettre à jour si Deezer change son interface.

## Sélecteurs (dans `#page_player`)

| Élément | `data-testid` | Notes |
|---|---|---|
| Titre | `item_title` | contient un `<a>` vers l'album |
| Artistes | `item_subtitle` | un `<a>` par artiste |
| Pochette | `item_cover` | `<img>` 500x500 |
| Lecture/pause | `play_button_play` / `play_button_pause` | le suffixe indique l'action proposée : `pause` = en lecture |
| Précédent / suivant | `previous_track_button` / `next_track_button` | |
| Aléatoire | `shuffle_play_button_off` / `_on` | |
| Répétition | `repeat_button_off` → `_all` → `_single` | cycle à chaque clic |
| Coups de cœur | `add_to_favorite_button_off` / `_on` | |
| Progression | `progress_bar` | `input[type=range]`, `max` = durée (s), `aria-valuenow` = position précise |
| Temps | `elapsed_time` / `remaining_time` | texte `mm:ss` |
| Bouton volume | `volume_button_default` / `volume_button_mute` | `_mute` quand le volume est à 0 |
| Slider volume | `volume_menu_bar` | `input[type=range]` 0-100, dans un popover hors de `#page_player`, rendu seulement au survol du bouton |

## Volume

Le slider n'existe que quand le menu est ouvert. Pour le lire ou le régler, on envoie `mouseover` au bouton, on attend le slider avec un `MutationObserver` (~0,2 à 0,7 s ; pas de boucle de `setTimeout`, car Firefox ralentit les timers des onglets en arrière-plan à 1 s minimum), on le règle comme la barre de progression, puis on referme avec `mouseout` (`relatedTarget: document.body`). La valeur reste en cache dans le content script : la lire dans `readState()` ouvrirait le menu à chaque mutation et bouclerait avec le `MutationObserver`. Le popup la lit une fois à l'ouverture (`readVolume`), puis envoie `setVolume` pendant le glissement, une commande à la fois. L'icône haut-parleur coupe le son de l'onglet (`tabs.update({ muted })`), indépendamment du volume Deezer.

## Seek

Le slider est un composant React (`onMouseDown`, `onChange`, `onMouseUp`). La position n'est validée qu'au relâchement : il faut envoyer `mousedown`, fixer la valeur avec le setter natif de `HTMLInputElement`, puis envoyer `input` et `mouseup`. Un simple `input`/`change` ne fait rien.

## Onglets en veille

Au démarrage, Firefox restaure les onglets sans les charger (`tab.discarded`) : pas de page, donc pas de content script. Le background les réveille avec `tabs.reload()`, ce qui charge l'onglet sans l'activer. Le popup le fait sans attendre et reçoit l'état quand le lecteur apparaît ; les raccourcis clavier attendent que le lecteur soit prêt (15 s max) avant d'agir. Si un onglet chargé ne répond pas, le content script est réinjecté avec `scripting.executeScript` (protégé contre la double injection).

## Erreurs d'action

Une action qui échoue dans le content script renvoie l'état courant avec un champ `error`, affiché en rouge dans le popup. Elle ne rejette pas la promesse : le background traiterait ce rejet comme « onglet pas prêt » et le popup basculerait sur l'écran de chargement.

## Limites connues

- Pas d'écoute sans page Deezer : l'API publique ne fournit que des extraits de 30 s et le SDK de lecture est déprécié. L'onglet caché sert de compromis.
- Politique d'autoplay de Firefox : tant que l'utilisateur n'a pas cliqué dans l'onglet Deezer, le son est bloqué. Les clics simulés par le content script ne comptent pas, et aucune API WebExtension ne permet de changer la permission. Seul contournement : autoriser l'audio et la vidéo pour deezer.com (icône à gauche de l'adresse → Lecture automatique). Le content script lit `navigator.getAutoplayPolicy("mediaelement")` (Firefox 112+) Le popup n'affiche un avertissement avec ces étapes qu'après un vrai échec : clic sur lecture, puis 1,5 s plus tard l'onglet n'est pas `audible` et la politique n'est pas `allowed`. L'avertissement disparaît dès que la politique passe à `allowed`, après un clic dans l'onglet ou une fois le site autorisé.
- Onglet jamais affiché (onglet caché créé par l'extension, onglet en veille réveillé) : Firefox retient le son tant que l'onglet n'est pas passé au premier plan, même avec l'autoplay autorisé. `getAutoplayPolicy()` répond alors `allowed`, et rien ne signale le blocage : Deezer reste en pause, sans erreur. Une détection après coup (« Deezer en lecture mais onglet muet ») ne marchait donc pas. Le background mémorise dans `storage.session` les onglets déjà activés (`tabs.onActivated`). Avant un play sur un onglet Deezer jamais activé, non audible et en pause, il affiche l'onglet 300 ms puis revient à l'onglet précédent (`ensureForegroundedOnce`). Effets visibles : un court flash au premier play et, souvent, la fermeture du popup. Un onglet affiché avant le démarrage du background n'est pas connu : il provoque un flash inutile, une seule fois.
