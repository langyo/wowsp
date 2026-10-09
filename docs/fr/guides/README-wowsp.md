<h1 align="center">WoWSP</h1>

<p align="center"><strong>Panneau de bataille libre et open source pour World of Warships — revue des replays, overlay en jeu, suivi de bataille en direct et statistiques complètes, pour Windows et Android.</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![Release](https://img.shields.io/github/v/release/langyo/wowsp)](https://github.com/langyo/wowsp/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/langyo/wowsp/total)](https://github.com/langyo/wowsp/releases)

</div>

<div align="center">

[English](../../en/guides/README-wowsp.md) ·
[简体中文](../../zh-CN/guides/README-wowsp.md) ·
[繁體中文](../../zh-TW/guides/README-wowsp.md) ·
[日本語](../../ja/guides/README-wowsp.md) ·
[한국어](../../ko/guides/README-wowsp.md) ·
**Français** ·
[Español](../../es/guides/README-wowsp.md) ·
[Русский](../../ru/guides/README-wowsp.md) ·
[العربية](../../ar/guides/README-wowsp.md)

</div>

![Tableau de bord de WoWSP](../screenshots/dashboard.webp)

> [!IMPORTANT]
> **WoWSP est entièrement gratuit et open source, distribué uniquement via les [GitHub Releases](https://github.com/langyo/wowsp/releases) officiels. Quiconque le vend n'en est pas l'auteur — ne payez pas ; si c'est déjà fait, demandez un remboursement et signalez le vendeur.**

WoWSP est un panneau de bureau pour **World of Warships** sous Windows, avec une application compagnon Android. Il détecte automatiquement votre installation du jeu — Wargaming Game Center, Steam, Lesta ou 360 — et vous accompagne sur tout le cycle : revoir la partie après coup, la suivre en direct et lire les rapports de force pendant que vous jouez.

## Contenu

- **Revue des replays** — ouvrez n'importe quel `.wowsreplay` et revoyez la partie sur une carte 3D holographique : trajectoire de chaque navire, obus, torpilles et escadrilles d'avions, cercles de portée, météo de cyclone et simulation des zones de capture. Caméras en orbite libre, en vue de l'enregistrement original et en suivi de navire ; étiquettes de carte qui restent toujours lisibles ; et résultats de bataille joueur par joueur (rubans, distinctions, composition des dégâts) à côté de la carte. Chaque panneau exporte une image de partage pouvant masquer les pseudonymes, et la bibliothèque filtre par mode, par date et par état d'archivage.
- **Overlay en jeu** — en bataille, maintenez `Tab` pour superposer la composition et les statistiques des deux équipes au match ; l'overlay se réancre à chaque pression. Paliers de note personnelle (PR) et couleurs de taux de victoire, tampons, coloration des lignes des navires coulés, résumés par équipe et renseignement sur les consommables en maintenant Tab. Les statistiques s'affichent soit dans une fenêtre transparente au-dessus du tableau détecté, soit directement dans le jeu via le plugin premier parti inclus, avec un appariement des lignes ajusté pour chaque client (Wargaming, Lesta et le client CN).
- **Suivi de bataille en direct** — de l'écran de chargement à l'écran des résultats, regardez la bataille se dérouler : compositions complètes avec paliers de PR et tags de clan, taux de victoire d'équipe pondéré par palier, cartes de combat et rapport de bataille personnel en direct qui suit vos propres dégâts, vos distinctions et l'attribution de vos destructions.
- **Tableau de bord des statistiques et temps de jeu** — votre propre « compteur d'eau » : cartes de note personnelle, de taux de victoire et de dégâts moyens avec plages de dates, graphiques de répartition des navires (histogramme des paliers, anneaux par classe et par nation), historique des saisons classées et bascule multi-comptes. Une vue dédiée au temps de jeu transforme vos fichiers de replay en carte thermique de calendrier de batailles, avec sélecteur d'année.
- **Recherche de joueurs et de clans** — recherchez n'importe quel joueur ou clan (avec prise en charge du pinyin), consultez les fiches de carrière et les effectifs de clan avec images de partage, et croisez les compositions des Batailles de clan entre serveurs.
- **Encyclopédie des navires et planificateur de configurations** — l'arbre technologique complet avec bascule des branches Wargaming/Lesta, vues des caractéristiques et du blindage, tendances serveur par navire, scènes de modèles 3D pour les navires et les avions, et un planificateur de configurations qui projette les compétences de commandant, les commandants, les signaux et les améliorations en caractéristiques finales, avec calcul des coûts en crédits et en XP.
- **Hub de mods** — un marché organisé de mods communautaires couvrant fonctionnalités, textures et voix (skins de navires, packs de voix Wwise avec aperçus), avec préréglages d'installation, mode sans échec en un clic, alertes de conflit, migration des mods obsolètes, analyse des remplacements de textures et mises à jour par lot.
- **Tableau tactique** *(en développement)* — un éditeur de plans tactiques s'appuyant sur le catalogue de cartes de bataille inclus : horloge de planification de 20 minutes, trajectoires d'unités, frises chronologiques d'actions et ensembles de plans partageables.
- **Compagnon Android** — appairez votre téléphone par Wi-Fi (découverte automatique) ou depuis n'importe où grâce à un code d'appairage à six chiffres via le relais intégré, récupérez les replays directement depuis votre ordinateur et revoyez-les en déplacement.

Sous le capot, le logiciel reste un citoyen natif : mises à jour automatiques avec mise en concurrence des miroirs (installations portables prises en charge), panneau dans la zone de notification, assistant de première prise en main, annonces dans l'application et formulaire de retours avec export des journaux ; thèmes, fonds d'écran, opacité de l'interface, taille de police et réglages DPI ; neuf langues d'interface ; une télémétrie anonyme minimale que vous pouvez désactiver ; et un WebView2 intégré qui se dégrade proprement en son absence.

## Téléchargement

Windows 10/11 — récupérez le dernier `WoWSP_<version>_x64-installer-webview2.exe` depuis [GitHub Releases](https://github.com/langyo/wowsp/releases/latest) (WebView2 est inclus), ou la [page de téléchargement](https://wowsp.langyo.xyz/download), qui choisit automatiquement un miroir, si GitHub est lent depuis votre région. L'édition Android se compile à partir des sources — consultez le [guide de compilation](building.md).

Des captures d'écran de chaque vue, dans chaque langue de l'interface, sont disponibles dans la [galerie du site](https://wowsp.langyo.xyz/#gallery).

## Documentation

L'architecture, les notes de conception et les guides se trouvent dans [`docs/`](../../) en neuf langues (anglais et 简体中文 entièrement traduits), construits avec [lagrange](https://github.com/celestia-island/lagrange). WoWSP envoie une télémétrie d'usage anonyme et minimale — ce qui est collecté (et ce qui ne l'est jamais) est détaillé dans [cette note de télémétrie](../license/usage-telemetry.md).

## Retours et crédits

Retours de bogues et de tests : groupe QQ **[1125770228](https://qm.qq.com/cgi-bin/qm/qr?k=b6kMIecv3d390ecZVWNQNWMFfLRVgcQ9&jump_from=webapi&authKey=NhNLVnIcIlmfnnDUCjpsra4C/zfciS1sYNjm5SV7x2RPhdP1CzOM91ObP9y9MMQV)**, ou le formulaire de retours sur le [site](https://wowsp.langyo.xyz). L'analyse des replays et les principes de détection du jeu sont adaptés d'[ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar) ; le shell frontend et l'infrastructure de compilation sont adaptés de [shittim-chest](https://github.com/celestia-island/shittim-chest).

## Licence

WoWSP est distribué sous la **Synthetic Source License 1.0** ([texte intégral](https://github.com/langyo/wowsp/blob/master/LICENSE)) — des droits équivalents à ceux d'Apache-2.0 pour une base de code substantiellement générée par IA, dont la seule obligation supplémentaire est de conserver la mention de divulgation de génération par IA sur chaque copie et chaque œuvre dérivée. L'instantané « vendored » de [wows-toolkit](https://github.com/langyo/wowsp/tree/master/packages/tools/wowsunpack-vendor) conserve sa licence **MIT** d'origine ; tout le reste du dépôt — y compris le worker autonome [pairing-relay](https://github.com/langyo/wowsp/tree/master/packages/pairing-relay) — est couvert par la SySL-1.0.

## Soutenir le projet

WoWSP est et reste gratuit. S'il l'a mérité et que vous souhaitez aider, la page afdian de l'auteur est **[afdian.com/a/langyo](https://afdian.com/a/langyo)** — **chaque don est intégralement consacré aux coûts d'IA du développement de WoWSP** (appels de modèles et outils de génération de code).

Pour que les responsabilités restent claires :

- Faire un don est entièrement facultatif et jamais requis — toutes les fonctionnalités sont gratuites, et le logiciel n'embarquera jamais de fonctions réservées aux donateurs.
- Un don est un cadeau volontaire : il ne crée aucune relation d'emploi, de commande ni aucun autre lien juridique, et n'ouvre aucun droit sur des fonctionnalités, des délais ou un remboursement.
- Le projet reste open source sous la licence ci-dessus, pour tous — donateurs comme non-donateurs.
- WoWSP est un projet indépendant et non officiel, sans relation directe avec Wargaming, Lesta ou 360.
