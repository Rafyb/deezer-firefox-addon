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
| File d'attente | `queue_list_button` | bascule le panneau ; ouvert, il contient `queue_content` (hors `#page_player`) |
| Slider volume | `volume_menu_bar` | `input[type=range]` 0-100, dans un popover hors de `#page_player`, rendu seulement au survol du bouton |

## Volume

Le slider n'existe que quand le menu est ouvert. Pour le lire ou le régler, on envoie `mouseover` au bouton, on attend le slider avec un `MutationObserver` (~0,2 à 0,7 s ; pas de boucle de `setTimeout`, car Firefox ralentit les timers des onglets en arrière-plan à 1 s minimum), on le règle comme la barre de progression, puis on referme avec `mouseout` (`relatedTarget: document.body`). La valeur reste en cache dans le content script : la lire dans `readState()` ouvrirait le menu à chaque mutation et bouclerait avec le `MutationObserver`. Le popup la lit une fois à l'ouverture (`readVolume`), puis envoie `setVolume` pendant le glissement, une commande à la fois. L'icône haut-parleur coupe le son de l'onglet (`tabs.update({ muted })`), indépendamment du volume Deezer.

Les raccourcis volume +/− (`changeVolume`) partent de la valeur du slider, pas du cache, qui peut être périmé si le volume a changé dans la page. Comme le slider est hors de `#page_player`, l'observer ne voit pas le changement : `changeVolume` appelle `schedulePush()` pour mettre à jour un popup ouvert.

## Minuterie de veille

Le background crée une alarme `sleep-timer` (`browser.alarms`, qui survit au déchargement de l'event page, contrairement à `setTimeout`). Son `scheduledTime` est le seul état : le popup le lit avec `remote:getSleepTimer` et affiche les minutes restantes. À l'échéance, le background envoie `fadeOutAndPause` à l'onglet Deezer, sans le réveiller s'il est en veille. Le content script baisse le volume en 15 paliers d'une seconde, rouvrant le menu volume à chaque palier au cas où Deezer le refermerait, met en pause, attend 500 ms puis remet le volume initial. Le fondu est facultatif : si le menu volume est inutilisable (bouton absent, slider qui n'apparaît pas), la pause a lieu quand même. Si l'utilisateur met en pause pendant le fondu, celui-ci s'arrête et le volume est restauré. Un changement de volume par l'utilisateur annule le fondu sans pause et garde son volume ; un nouveau réglage de la minuterie (`cancelFade`) l'annule et restaure le volume. À l'échéance, le drapeau d'auto-pause est effacé (dans la file des événements de l'auto-pause), pour que la fin d'une vidéo ne relance pas la musique. Pendant le fondu (`sleepFading`), une auto-pause met en pause sans poser de drapeau, donc sans reprise ensuite. `sleepFading` repasse à `false` dès qu'une nouvelle minuterie est réglée, sans attendre la réponse du fondu annulé, et toujours via la file de l'auto-pause. Il n'existe qu'en mémoire : on suppose que l'event page reste chargée pendant le fondu (environ 20 s, sous le délai d'inactivité de 30 s, et le content script pousse un état à chaque palier). Si une nouvelle minuterie a été réglée juste à l'échéance (son `cancelFade` arrivé avant le fondu), l'alarme le voit (`alarms.get`) et ne lance pas le fondu.

## Mini-lecteur

Même page que le popup, ouverte avec `?detached` dans une fenêtre `windows.create({ type: "popup" })`, 340x500. La classe `detached` sur `<html>` libère la largeur fixe, la ligne Options est toujours affichée en bas de la fenêtre, sans le bouton engrenage, et les actions qui ferment le popup (afficher l'onglet Deezer) ne ferment pas la fenêtre. Un seul mini-lecteur : le bouton remet au premier plan la fenêtre existante (recherche par URL, possible grâce à la permission `tabs`). Firefox n'offre aucun moyen de la garder au premier plan. Pas d'API `windows` sur Android : le bouton y est masqué.

Le mini-lecteur reste ouvert longtemps : il suit les changements faits ailleurs. Un état poussé par un autre onglet Deezer, ou un état « indisponible », relance `remote:getStatus` ; `tabs.onUpdated` (`hidden`, `mutedInfo`, `discarded`) et `tabs.onRemoved` sur l'onglet suivi aussi. Un seul rafraîchissement à la fois, relancé à la fin s'il en a été demandé un pendant ; il ne passe pas par `call()`, pour ne pas effacer une erreur affichée. Ces rafraîchissements automatiques envoient `remote:getStatus` avec `wake: false` : un onglet que Firefox vient de décharger (son `pagehide` envoie au mieux un état « indisponible », le contexte du content script peut disparaître avant ; `tabs.onUpdated` sur `discarded` couvre le cas) n'est pas rechargé, et aucun script n'est injecté dans une page en cours de fermeture. Le popup affiche alors « Firefox a mis l'onglet Deezer en veille » avec un bouton *Réveiller Deezer*. L'ouverture du popup et les commandes réveillent toujours l'onglet. L'onglet lecteur passe avant un autre onglet Deezer chargé, même en veille : le mini-lecteur affiche alors « en veille » plutôt que de basculer sur un onglet de recherche. Une page Deezer chargée sans lecteur (déconnexion, page de connexion ou bandeau cookies) ne pousse aucun état : le popup écoute aussi `status` et, page chargée (`loaded`) sans lecteur, affiche « En attente du lecteur Deezer… » avec un bouton *Afficher l'onglet Deezer* plutôt qu'un chargement sans fin. Les boutons d'options suivent `storage.onChanged`, la minuterie est relue toutes les 10 s.

## Notifications de changement de titre

Option désactivée par défaut, page d'options (`options_ui`), permission `notifications` optionnelle demandée au moment où l'utilisateur coche la case. Le background reçoit aussi les états poussés par le content script (`type: "state"`). Ces états arrivent environ une fois par seconde pendant la lecture (anti-rebond de 250 ms, progression mise à jour chaque seconde), donc les vérifications sont chaînées pour ne pas notifier deux fois. Le dernier titre (titre, artistes et lien, qui contient l'id du morceau) est gardé dans `storage.session`, car l'event page se décharge quand Deezer est en pause, et en mémoire pour que les états d'un même titre ne coûtent rien. Conséquence de ces états poussés chaque seconde : l'event page reste chargée pendant la lecture ; le traitement de chaque état lit donc d'abord la mémoire (onglet lecteur, `autoPaused`, dernier titre, onglet suivi par l'infobulle) plutôt que `storage.session`. Ces valeurs passent par `storedValue()` : chargées une seule fois, une lecture concurrente partage le même chargement et n'écrase jamais une valeur posée entre-temps ; un chargement échoué est retenté à la lecture suivante. Pas de notification si Deezer est en pause ou si l'onglet est actif dans la fenêtre au premier plan. Firefox ne gère pas les boutons dans les notifications : un clic affiche l'onglet Deezer. La pochette sert d'icône ; si Firefox la refuse, la notification part sans icône.

## Lien du titre

Le lien du titre dans le lecteur (`item_title a`) mène à l'album. L'ID du morceau n'est pas dans le DOM : le content script le lit via `window.wrappedJSObject.dzPlayer.getSongId()`, le lecteur historique de Deezer exposé en global, pour construire `https://www.deezer.com/track/<id>`. C'est un détail interne de la page, non vérifié en lecture (navigateur de test déconnecté le 2026-11-15) : en cas d'absence ou de valeur non numérique, on retombe sur le lien de l'album.

## Raccourcis activables

Le bouton clavier de la ligne Options ne se contente pas d'ignorer les commandes, sinon les combinaisons resteraient prises aux autres applications. À la désactivation, le background relève les raccourcis courants (`commands.getAll`), y compris ceux choisis par l'utilisateur, les garde dans `storage.local` (`savedShortcuts`) et les vide (`commands.update` avec `shortcut: ""`). À la réactivation, il les restaure, sauf ceux que l'utilisateur a réassignés à la main dans `about:addons` entre-temps. La présence de `savedShortcuts` signifie « désactivés ». Les changements sont exécutés l'un après l'autre (deux clics rapides enregistreraient une liste partielle). À une mise à jour de l'extension (`onInstalled`, `reason: "update"`), si les raccourcis sont désactivés, ceux d'éventuelles nouvelles commandes sont aussi sauvegardés puis vidés. Pas d'API `commands` sur Android : le bouton y est masqué.

## Recherche depuis le texte sélectionné

Entrée de menu contextuel (`menus`, contexte `selection`), activée par défaut, désactivable depuis la ligne Options du popup (`searchMenuEnabled` dans `storage.local`). Le menu est recréé à `runtime.onInstalled` et `runtime.onStartup` (`removeAll` puis `create` avec `visible`), il existe donc toujours ; une bascule ne fait que `menus.update({ visible })`, car deux recréations rapprochées s'entrelaceraient. Par précaution, si `update` rejette (menu absent, par exemple après désactivation puis réactivation de l'extension si Firefox ne le garde pas), le menu est recréé. La recherche s'ouvre dans un nouvel onglet, à droite de l'onglet courant (`https://www.deezer.com/search/<texte>`) : naviguer dans l'onglet Deezer existant le rechargerait et couperait la musique.

Cet onglet est une page Deezer complète : pour que la télécommande ne bascule pas dessus, le background retient l'onglet lecteur (`playerTabId` dans `storage.session`), mis à jour au lancement en arrière-plan, à chaque état « en lecture » et juste avant d'ouvrir une recherche. `findDeezerTab` choisit l'onglet audible, puis l'onglet lecteur, puis un onglet chargé, puis un onglet en veille.

## Pause automatique

Option désactivée par défaut (`autoPauseEnabled`). Le background écoute `tabs.onUpdated` filtré sur `audible` et `mutedInfo`. Quand un onglet autre que Deezer devient audible et non muet alors que Deezer joue, il met Deezer en pause et note l'heure et l'onglet Deezer mis en pause dans `storage.session` (`autoPaused`, `{ at, tabId }`), car l'event page peut se décharger pendant une longue vidéo. Quand cet onglet se tait, devient muet ou se ferme, et qu'aucun autre onglet n'est audible, il relance cet onglet Deezer-là, jamais un autre (par exemple un onglet de recherche) ; s'il a été fermé, a quitté Deezer ou a été déchargé par Firefox entre-temps, rien n'est relancé. Il écoute aussi `tabs.onRemoved`, car un onglet fermé ne signale pas toujours `audible: false`. Le réglage `autoPauseEnabled` est gardé en mémoire : chaque son dans n'importe quel onglet réveille l'event page, mais seul le premier événement après un réveil relit le stockage. Les événements d'onglets sont traités l'un après l'autre : fermer un onglet vidéo peut signaler `audible: false` et la fermeture presque en même temps, et deux `play` envoyés avant que le bouton de Deezer change se remettraient en pause l'un l'autre. Une fois Deezer mis en pause, un deuxième onglet qui devient audible ne fait rien. Il ne relance que ce qu'il a lui-même mis en pause : le drapeau est effacé dès qu'un état « en lecture » arrive de Deezer, sauf dans les 2 s qui suivent la pause, où des états poussés juste avant disent encore « en lecture ». Firefox met environ 2 à 3 s à passer un onglet en `audible: false` : la reprise a ce délai.

## Infobulle de l'icône

Le background reçoit les états poussés par le content script et met « Titre - Artistes » dans `action.setTitle`, ou remet le nom de l'extension (`title: null`) quand le lecteur n'est pas prêt, ou que l'onglet suivi est fermé, déchargé par Firefox ou quitte Deezer. Pour ce dernier cas, le content script envoie un dernier état « indisponible » sur `pagehide` ; pas d'écoute de `tabs.onUpdated` sur `url`, qui réveillerait l'event page à chaque navigation dans n'importe quel onglet. Si ce message se perd, l'état poussé par un autre onglet Deezer prend la main dès que l'onglet suivi n'est plus sur Deezer. L'infobulle suit un seul onglet : le premier qui pousse un état, remplacé par tout onglet qui joue. Un onglet Deezer en pause (par exemple une recherche) ne l'écrase donc pas. L'onglet suivi est gardé dans `storage.session`, car le titre reste affiché après le déchargement de l'event page. Les mises à jour sont exécutées l'une après l'autre : deux états arrivant ensemble (un onglet en lecture, un en pause) pourraient sinon voir tous deux « aucun onglet suivi » et laisser gagner l'onglet en pause.

## Contrôles introuvables

`readState()` renvoie `missing`, la liste des contrôles de `CONTROLS` absents de la page. Le popup les grise avec une infobulle au lieu d'afficher une erreur au clic : après une refonte de Deezer, on voit tout de suite ce qui est cassé.

## Media Session

Deezer gère déjà `navigator.mediaSession` (relevé le 2026-10-19, bundle `route-naboo`) : métadonnées (titre, artiste, album, pochette), actions `play`, `pause`, `previoustrack`, `nexttrack`, `seekbackward`, `seekforward`, `seekto`, et `setPositionState`. Le son passe par un élément `<audio>` détaché du DOM (`player-Adapter`), donc Firefox branche les touches média et les contrôles média de l'OS sur l'onglet, même caché (vérifié avec la superposition média de Windows 11). L'extension n'y touche pas : redéclarer des handlers ou des raccourcis `MediaPlayPause` dans `commands` doublerait chaque action.

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
