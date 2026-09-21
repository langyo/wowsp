# Avis de télémétrie d'utilisation

**Applicable à WoWSP 0.4 et versions ultérieures.**

WoWSP collecte une quantité minimale de données de télémétrie d'utilisation afin de comprendre quelles fonctionnalités sont réellement employées et d'orienter les développements futurs. Cet avis décrit précisément ce qui est collecté, ce qui ne l'est jamais, et la manière dont les données sont traitées.

## Ce que nous collectons

- **La langue de l'interface.** La langue signalée par votre système d'exploitation, afin de savoir quelles langues de l'interface sont réellement utilisées. Aucun autre usage ni aucune préférence n'en sont déduits.
- **Les pages de l'application qui sont ouvertes** (pages vues au niveau des routes, par exemple le tableau de bord ou la vue replay).
- **Une région approximative** déduite de l'adresse IP (au niveau du pays) et le nombre approximatif d'installations actives par jour. L'adresse IP complète n'est jamais stockée.

## Ce que nous ne collectons jamais

- Les informations personnelles identifiantes : ni nom, ni adresse e-mail, ni identifiant de compte de jeu.
- Le contenu de vos replays, votre pseudo de joueur, ou toute donnée en jeu liée à votre compte.
- Le contenu du système de fichiers, les valeurs de configuration, ou tout ce que vous saisissez dans l'application.

## Comment les données sont traitées

La télémétrie est transmise à Google Analytics et conservée selon les conditions standard de traitement des données de Google. Les données sont agrégées uniquement à des fins de statistiques d'utilisation des fonctionnalités ; elles ne sont ni vendues, ni partagées avec des tiers à des fins marketing, ni utilisées pour établir des profils individuels.

## Désactiver la télémétrie

La version de bureau limite la télémétrie aux signaux d'utilisation décrits ci-dessus et aucune collecte n'a lieu avant la fin de l'assistant de premier démarrage. L'application étant entièrement open source, le code de la télémétrie peut être consulté à tout moment dans le dépôt.
