# Plugin de statistiques en jeu — conception de télémétrie de précision

> **Statut** : expérience conclue (2026-09-28) ; prête pour l'implémentation.
> Document compagnon de l'overlay : la couche d'affichage reste la fenêtre
> transparente ; ce plugin est la source de données en jeu qui garde les
> états vivant/coulé de l'overlay exacts sur toute configuration, plein écran
> exclusif compris. L'ORDRE des lignes TAB reste une inférence calibrée par
> client jusqu'à ce que la sonde puisse lire l'ordre propre du jeu dans le
> moteur — voir la règle d'ordonnancement ci-dessous.

## Contexte et objectifs

L'overlay de bataille en direct infère aujourd'hui la géométrie du tableau
des équipes de la touche TAB en capturant l'écran (`overlay/capture.rs`,
`overlay_detect.rs`) et interroge `GetAsyncKeyState(VK_TAB)` toutes les
30 ms. Cela fonctionne, mais :

- la capture d'écran est la couche la plus fragile (exclusions DRM/capture,
  HDR, multi-DPI, particularités fenêtré vs plein écran) ;
- l'interrogation de l'état des touches ne peut pas distinguer « Tab
  maintenu » de « Tab saisi dans le chat de bataille » ;
- l'ordre des lignes est déduit d'un roster statique complété d'heuristiques
  de coulage.

Un mod en jeu tournant sur la **Mods API** officielle de Wargaming (le canal
PnFMods, pas d'injection, aucune écriture en mémoire) peut observer l'état
de la bataille depuis l'intérieur du client et le transmettre à WoWSP via
un pont par fichiers. Le mod ne rend **rien** à l'écran — l'overlay
transparent reste l'affichage — donc l'approche n'emporte aucune de la
maintenance d'UI propre à chaque version du jeu qui avait tué les idées
antérieures de « rendu dans le jeu ».

Objectif : faire de « télémétrie du mod > inférence par capture d'écran >
ordre statique » la chaîne de priorité des données de l'overlay, pilotée
par un nouveau mode de roster `"plugin"` dans `overlay_config.toml`.

## Ce que l'expérience a prouvé

Vérifié sur Steam-ASIA 15.8.0 (build 13187581) et 360-CN 15.8.1 (build
13243917), plusieurs batailles sur chacun ; artefact de la sonde dans
`packages/ingame-plugin/src/Main.py` (se déclare `0.1.0` pour
toujours ; l'itération ne vit que dans l'historique git) :

| Capacité | Mécanisme | Latence / notes |
| --- | --- | --- |
| Chargement du mod, les deux realms | `res_mods/<bin>/PnFModsLoader.py` (marqueur de 0 octet) + `PnFMods/<Mod>/Main.py`, `API_VERSION = 'API_v1.0'` | coexiste avec les mods d'Aslain |
| Modules d'API injectés | `events, ui, utils, battle, callbacks, dataHub, constants` sont des globales injectées par le chargeur ; leur `import` échoue (liste blanche), ne jamais les masquer | les builtins sont aussi en liste blanche : pas de `globals()`/`eval` |
| Roster et identité | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm | les enregistrements sont des `SafeClass` : l'indiçage fonctionne, le protocole dict non ; itérer défensivement pendant le chargement initial (le conteneur est brièvement non-dict) |
| Attribution des coulages | basculements de `isAlive`, interrogés à 1 s | validé 1:1 contre les lignes de journal `typeDeath` du jeu lui-même, retard ≤1 s, sur 4 batailles |
| Santé en direct et détection | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]` (`.value/.max/.isAlive`), `entity[CC.relation]` | les PV ennemis restent à 0/0 jusqu'à détection — même brouillard de guerre que la table du jeu ; un saut 0→valeur est en soi un événement de détection |
| État de l'écran TAB | événements SFM `input.tabModeIn` / `input.tabModeOut` | se déclenche ≤3 ms après la touche ; ne se déclenche **pas** pour un Tab dans le chat — corrige d'emblée toute la classe des faux positifs |
| Remaniement du roster | `events.onPlayersListUpdated` | 14 événements en une bataille |
| Cycle de vie de la bataille | `sfm.battleLoadingStarted`, `request.showBattle`, `onBattleStart`, `up.exitBattle`, `window.hide(Battle)` | à grain plus fin que l'apparition/disparition du fichier tempArenaInfo |

**Non disponible** (et non nécessaire) : les composantes de score/XP par
joueur n'existent pas sur les entités avatar, et le chemin côté unbound
`$datahub.getCollection().getChildByPath('team.ally.sortedAlive')` n'a pas
d'équivalent côté Python (`getCollection` n'existe pas sur le dataHub
injecté).

**Règle d'ordonnancement — INSTABLE, connaissance propre à chaque client ;
la vérité doit venir de l'intérieur du jeu.** L'ordre des lignes du tableau
TAB est celui que rend le HUD de chaque client, et les éditeurs ont
véritablement divergé (le premier modèle « ordre des véhicules de l'arène
avec les coulés réajoutés à la fin » n'a jamais été que l'approximation de la
famille WG — les groupes d'égalités qu'il ne pouvait résoudre sont ce que les
pastilles à points de #604 ont maquillés). Calibrez par realm contre de
VRAIES captures de Tab, attendez-vous à ce qu'il bouge à chaque mise à jour
du client, et ne considérez la décompilation des scripts que comme un indice
corroborant — jamais comme une preuve. La matrice du 2026-10-09, décompilée
depuis les installations de cette machine (wowsdeob, `ShipSystem.add` /
`AvatarSystem.__sortKeyAlive`) :

- **Famille WG** (eu/na/asia partagent un même build) : drapeau vivant, rang
  de classe (CV < BB < CA < DD < SS < auxiliaire), tier décroissant, rang
  `NATION.SORT_ORDER`, nom court localisé du navire, `[TAG]pseudo` — une
  seule chaîne concaténée. La 15.8.0 en production a été vérifiée 6/6 sur
  une capture de Tab (2026-09-27), et le build SUIVANT (13357625, téléchargé
  le 2026-10-06) se décompile en la MÊME formule à rang de nation en tête —
  WG n'a pas bougé.
- **360-CN** : son propre Python (les builds 13243917 ET l'actuel 13357822)
  calcule toujours la clé de rang de nation de WG, mais le client REND
  l'ordre par nom de navire localisé (capture du 2026-10-07, 9/9 pinyin) —
  la divergence vit dans la couche HUD/vue. La décompilation de scripts ne
  peut donc JAMAIS trancher ce client ; seules les captures rendues comptent.
- **Lesta** (ru) : rend lui aussi l'ordre par nom de navire localisé
  (capture du 2026-10-09 : le Bogatyr devançait deux lignes de St. Louis à
  rebours de `usa < russia`) ; son build actuel (8867689) embarque un
  conteneur `.pyc` modifié que le décompilateur ne sait pas encore ouvrir.

L'app encode cela en gardes par realm sur la clé de tri hors ligne (le
`realmUsesShipNameOrder` de utils/realms ; utils/shipClass porte la clé
elle-même et la disposition statique CN) et refuse de présenter l'inférence
comme vérité du jeu : un plugin CONNECTÉ continue d'être évalué « pas
totalement fonctionnel » dans l'en-tête du panneau /live (pastille
d'avertissement + tooltip, `features/replay/telemetryGrade.ts`), car la
charge utile de télémétrie porte les états vivant/coulé mais AUCUN ordre de
lignes. La fin du chemin, c'est la sonde qui lit l'ordre propre du jeu dans
le moteur — la collection que TAB rend (`team.ally.sortedAlive`) est la
source naturelle, mais `getCollection` n'existe pas sur le dataHub injecté ;
un futur contrat de charge utile (`order: {ally: [...], enemy: [...]}`,
contenu vrai du jeu uniquement) fera repasser la pastille à « exact ».
D'ici là, l'inférence est un repli calibré, rien de plus.

## Contraintes du bac à sable (durement acquises, à conserver dans le guide de style du mod)

- Python est en **2.7** ; garder une syntaxe conservatrice (pas de
  f-strings ; la sonde existante est volontairement compatible 2/3).
- `open()` n'a **pas de mode append** ('a' renvoie None au lieu de lever
  une exception) : réécrire les fichiers en entier depuis des tampons en
  mémoire.
- Les fichiers manquants consignent une ligne d'erreur côté moteur avant
  de lever une exception : amorcer une fois au chargement chaque boîte aux
  lettres interrogée (voir l'amorçage de `manual_refresh.flag`).
- Les exceptions qui s'échappent d'un callback tuent le mod silencieusement :
  tout envelopper, dédupliquer les erreurs répétées avant journalisation.
- `dir()` sur les modules injectés renvoie `[]` (enveloppes SafeClass) : la
  surface d'API n'est que la liste de noms éprouvés ci-dessus.
- Deux canaux de chargeur existent : le chemin classique PnFMods 1.0 non
  signé que nous utilisons, et la « ModsAPI 2.0 » avec validation de
  signature WG (mods signés de classe ModStation). Les mods communautaires
  non signés cohabitent bien ; les échecs de signature des packs tiers ne
  nous concernent pas.

## Architecture

```
┌─ client de jeu (bac à sable Mods API, sans réseau) ───────┐
│ PnFMods/WoWSPStats/Main.py                                │
│  · interrogation du roster (1 s, confirmation stable)     │
│    → request.json                                         │
│  · parcours des entités → télémétrie (hp/relation/alive)  │
│  · événements SFM → marqueurs tabMode, marqueurs          │
│    de cycle de vie                                        │
│  · heartbeat.json (phase port/battle, 1–2 s)              │
└──────────────┬────────────────────────────────────────────┘
               │ fichiers JSON plats dans le répertoire propre du mod
┌──────────────┴────────────────────────────────────────────┐
│ Application WoWSP (Rust, processus existants)             │
│  · lecteur/écrivain du pont (remplace le rôle de          │
│    compagnon de la sonde d'expérimentation ; même         │
│    protocole request/response que le plugin de            │
│    référence tiers a établi)                              │
│  · moteur d'ordonnancement : ordre arène + coulage des    │
│    morts en fin de liste                                  │
│  · mode roster "plugin" dans overlay_config               │
│  · contrôle de santé : analyser profile/python.log        │
│    pour les lignes de chargement/auto-vérification        │
│    du mod (api[load] dh=True …)                           │
└───────────────────────────────────────────────────────────┘
```

Fichiers du pont (protocole v1, tous dans le répertoire du mod) :

```jsonc
// request.json — écrit par le mod sur un roster stable (et réécrit lors
// d'un rafraîchissement manuel). Le compagnon répond avec les lignes de
// statistiques.
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json — écrit par WoWSP ; la revision doit être monotone par
// session ; un fichier vide (sans newline final) signifie « en attente ».
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json — réécrit toutes les 1–2 s ; périmé = mod mort ou jeu
// fermé.
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3 }

// journal de télémétrie — réécriture entière d'un anneau borné par
// bataille ; chaque état distinct plus les marqueurs d'événement sur une
// seule chronologie :
{ "t": 1690000000000, "players": { "<avatarId>": { /* projection */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag — WoWSP écrit un horodatage epoch-seconds frais pour
// déclencher une nouvelle requête ; le mod le consomme dans une fenêtre
// de 10 s.
```

## Intégration produit

1. **Installation automatique au basculement** : l'activation de la source
   d'ordonnancement en jeu dans les paramètres écrit le mod via le chemin
   existant `mod_install.rs` / `mod_templates` (marqueur
   `PnFModsLoader.py` seulement si absent ; fichiers propres uniquement ;
   snapshot + rollback ; garde « jeu fermé »). Désactiver désinstalle.
   C'est le comportement d'enregistrement « spécial » spécifié par le
   propriétaire : le plugin n'apparaît jamais comme une étape
   d'installation manuelle.
2. **Enregistrement dans les Discussions du dépôt** : publier un fil de
   ressource suivant le gabarit sur `langyo/wowsp/discussions` et le
   référencer depuis une entrée `mod-index.json` (`category`,
   `discussion`, compatibilité `versions[].game`) pour que le Mod Hub
   puisse aussi le lister/vérifier comme n'importe quel autre mod —
   provenance first-party, même machinerie de catalogue (modèle de
   consentement de la lacune G8 de mod-hub.md).
3. **Chaîne de repli** : télémétrie absente/périmée (heartbeat plus vieux
   que N s, `api[load] dh=False`, jeu mis à jour et mod cassé) → repli
   silencieux vers le pipeline d'inférence actuel. L'overlay ne dépend
   jamais du mod pour fonctionner.

## Risques et maintenance

- **La dérive de l'API WG** est désormais le seul couplage (pas d'unbound,
  pas de copies d'éléments natifs). La surface de la Mods API v1.0 est
  restée stable de 13.x à 15.8 ; la ligne d'auto-vérification de la sonde
  rend les cassages bruyants et faciles à diagnostiquer.
- **Client CN** : vérifié fonctionnel ; le client 360 exécute le même
  chargeur Mods API (son journal scanne nativement `PnFModsLoader.py`).
  Surveiller les changements de politique anti-cheat CN à chaque version
  majeure.
- **Perf** : l'interrogation à 1 s de `getPlayersInfo` + le parcours des
  entités tiennent largement dans le budget (des mods type TeamHP
  parcourent les entités à chaque image) ; ne jamais utiliser
  `callbacks.perTick` pour cela.
- **Croissance du journal** : anneau borné par bataille ; expédier les
  segments avec le replay si utile pour l'analyse post-bataille.

## Carte d'intégration Rust (points de contact exacts)

| Préoccupation | Fichier (existant sauf mention contraire) | Modification |
| --- | --- | --- |
| Observateur des fichiers du pont | voisin de `commands/arena_info.rs` : nouveau `commands/ingame_bridge.rs` | surveiller le répertoire du mod avec `notify` ; analyser heartbeat/request/journal ; exposer les événements Tauri `wowsp://ingame-*` |
| Moteur d'ordonnancement | nouveau module `overlay/order_source.rs` | réducteur « ordre arène + coulage des morts en fin de liste » alimenté par les événements du pont ; émet l'ordre final des lignes que l'overlay rend |
| Schéma de configuration | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster` acquiert `"plugin"` (chaîne de priorité `plugin > inferred > ocr > off`) |
| Déclenchement de l'overlay par la touche | `overlay/placement.rs` (`tab_key_down`) | quand le pont est vivant, piloter l'affichage/masquage depuis les marqueurs `input.tabModeIn/Out` au lieu de l'interrogation `GetAsyncKeyState` |
| Installation / désinstallation | `commands/mod_install.rs` + `packages/ingame-plugin/` (nouveau sous-paquet) | le gabarit devient le `Main.py` du sous-paquet ; snapshot + rollback ; garde « jeu fermé » ; nettoyage de l'ancienne sonde |
| Contrôle de santé | `commands/ingame_bridge.rs` | analyser `profile/python.log` pour les lignes d'auto-vérification `probe … loaded` / `api[load] dh=True` du mod ; exposer le statut pour l'interface des paramètres |
| Lignes de statistiques | `wg_api.rs` / `wg_api_cn.rs` existants | inchangé — le compagnon écrit `response.json` depuis la même recherche par lots que l'overlay utilise aujourd'hui |

## Plan de tests

- **Conformité au bac à sable** : chaque changement livré de `Main.py`
  est validé contre la liste de contraintes (analyse en py2.7, pas de
  builtins bloqués, pas d'ouverture en mode append, callbacks protégés)
  plus `python -m py_compile`.
- **Test de fumée au port uniquement** (sans bataille) : lancer le jeu,
  rester au port ~15 s, quitter ; vérifier `injected names=[…]`,
  `api[load] dh=True` et un heartbeat frais dans `python.log`. C'est le
  protocole bon marché qui a gardé l'expérience honnête — le conserver
  comme test d'acceptation des installations.
- **Fixtures de bataille** : une co-op par realm ; vérifier que le journal
  contient l'instantané du roster, ≥1 basculement de `alive` provoqué par
  un coulage, des marqueurs tabMode, et que les lignes `typeDeath` de
  `python.log` correspondent 1:1 aux basculements.
- **Exercice de repli** : arrêter l'application (pas de compagnon),
  vérifier que le délai busy de 180 s du mod se rétablit et que la
  bataille suivante émet toujours une requête ; corrompre le répertoire
  du mod, vérifier que l'overlay se replie silencieusement vers
  l'inférence.

## Plan de livraison

- **M1** — passage en production : reléguer les batteries de découverte
  de la sonde derrière un drapeau de débogage ; geler le protocole du
  pont ; pont Rust + moteur d'ordonnancement + mode `roster = "plugin"`
  câblé dans le store de l'overlay.
- **M2** — bascule dans les paramètres, installation/désinstallation
  automatiques, contrôle de santé python.log, logique de repli sur
  péremption.
- **M3** — enregistrement Discussions, entrée de catalogue, canal de
  mise à jour (les incréments de gabarit suivent la version de
  l'application ; le fichier du mod lui-même change rarement).
