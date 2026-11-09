# Distribution des modèles IA : canal Hugging Face et miroirs multi-fournisseurs (contrat de conception)

> **Statut** : BROUILLON — le contrat d'implémentation de la vague `feat/ai-models`.
> Portée : publier les modèles intégrés de décision/scoring (poids ONNX, la
> table de routage des attributs de navire et les rasters LOS de terrain par
> carte) ainsi que leurs scripts d'entraînement/déploiement dans un dépôt de
> modèles Hugging Face public ; les servir aux clients via un nouveau canal de
> ressources `ai` signé avec des téléchargements fichier par fichier ; et
> généraliser l'échelle de miroirs réservée à GitHub en un contexte de miroir
> prenant en compte le fournisseur, commun à toutes les ressources
> téléchargeables.
>
> Hors portée : le canal de mise à jour de l'application gelé, le pack de
> ressources `res-latest` (il reste sur GitHub Releases), le pipeline
> d'entraînement lui-même et la publication des jeux de données de replays.

## 1. Problème et objectifs

Les modèles intégrés de décision (les têtes de scoring ONNX pour le tir et le
déplacement, le modèle de conseil routé par attributs, le modèle de torpille
optionnel, la table de routage et les rasters de ligne de vue (LOS) du terrain
par carte) n'ont **aucun canal de distribution du tout**. Ils existent sous forme de
sorties d'entraînement ignorées par git sous `scripts/experiments/out/` ; le
pack installé `<cache>/decisions` est un répertoire copié à la main que
l'application ne peut qu'inventorier et effacer. Il n'y a ni script de
publication, ni manifeste, ni hachage, ni téléchargeur, ni estampille de
version, ni garantie de couverture — aujourd'hui 35 des 96 identifiants de
carte connus portent un raster LOS, les deux modèles installés sont plus
anciens et font environ la moitié de la taille des exports fp32 actuels, et
les emplacements conseil/torpille sont simplement vides.

En même temps, l'application sait déjà servir un pack plus riche : le pack de
ressources `res-latest` est publié depuis ce dépôt, mis en miroir via une
échelle de type ghproxy pour les réseaux de Chine continentale, vérifié contre
des hachages sha256 officiels et appliqué de façon atomique. Le canal des
modèles de décision doit atteindre le même niveau d'ingénierie sans hériter
des contraintes du pack de ressources de 1.3 GB.

Objectifs :

1. **Un artefact public et reproductible.** Chaque publication de modèle est
   générée par un script versionné dans le dépôt, à partir d'un commit nommé
   du dépôt, et publiée dans un dépôt de modèles Hugging Face public avec ses
   scripts d'entraînement et de déploiement.
2. **Mises à jour indépendantes des versions de l'application — dans le cadre
   d'un contrat de caractéristiques.** Un modèle réentraîné peut atteindre
   les clients installés sans nouvelle compilation de l'application tant que
   son schéma d'entrée/de caractéristiques correspond à l'extracteur de
   caractéristiques en cours d'exécution ; un changement de schéma est par
   définition une version de l'application.
3. **Intégrité avant exécution.** Les fichiers de modèle sont analysés et
   exécutés par ONNX Runtime, donc le canal est fail-closed : un manifeste
   signé épingle le sha256 de chaque fichier et le commit Hugging Face, et une
   charge utile non signée ou non concordante n'est jamais installée.
4. **Accessibilité depuis la Chine continentale.** L'échelle d'exécution doit
   fonctionner là où `huggingface.co` est injoignable (vérifié depuis le
   réseau du mainteneur) sans coder en dur un miroir tiers unique.
5. **Un seul cadre de miroirs.** GitHub, Hugging Face et (plus tard)
   ModelScope partagent un seul contexte prenant en compte le fournisseur —
   réécriture des candidats, sondage, sélection par santé/endpoint collant et
   listes d'endpoints contrôlées contre la dérive — au lieu de cinq copies
   d'une liste de préfixes ghproxy.
6. **Aucun secret dans l'arborescence.** Les identifiants Hugging Face vivent
   dans l'environnement ou le magasin de jetons de l'utilisateur ; jamais dans
   un fichier versionné.

### 1.1 Entrées mesurées

| Artefact | Source (checkout de développement) | Taille |
| --- | --- | --- |
| modèle de tir (fp32, v2 avec ablation NONE) | `scripts/experiments/out/fire_model/v2plain_std/fp32.onnx` | 2,592,543 B |
| modèle de déplacement (fp32, 17 classes, ablation E11) | `scripts/experiments/out/move_model/node3/main/fp32.onnx` | 2,652,542 B |
| modèle de conseil de tir (fp32, E24 routé par attributs) | `scripts/experiments/out/fire_model/e24_attrs/fp32.onnx` | 2,595,135 B |
| modèle de torpille (fp32 ; int8 optionnel) | `scripts/experiments/out/torpedo_model/final/fp32.onnx` | 492,411 B (int8 136,214 B) |
| table de routage des attributs de navire | `scripts/experiments/ship_attributes.json` | 261,507 B |
| rasters LOS de terrain | sortie de `bake_terrain_los.py`, un `terrain_los.npz` par carte | 5,986-221,638 B chacun (35 cartes installées) |

Chaque fichier est bien en dessous du budget de 10 MB par mise à jour. Le
Hub stocke néanmoins les blobs binaires via Xet/LFS, donc `/resolve/` répond
par une redirection CDN signée plutôt que 200 ; le téléchargeur la suit
(Range/reprise sur l'hôte final) sans client Xet, et le manifeste signé plus
le sha256 par fichier garantissent que les octets font autorité (voir 4.2 et
7.8).

## 2. État actuel

| Domaine | Aujourd'hui | Conséquence |
| --- | --- | --- |
| Publication des modèles | aucune | les modèles ne peuvent atteindre les utilisateurs que par une copie manuelle |
| Pack installé | `<LOCALAPPDATA>/WoWSP/decisions`, copié à la main | périmé/partiel ; pas d'estampille ; modèles de mauvaise génération indétectables |
| Chargement des modèles | échelle `decision_serve` env -> emplacement du pack -> sortie de dev ; `ship_attrs` utilise une table `include_str!` à la compilation | un changement de table de routage exige une version de l'application ; le commentaire « le pack écrase la table embarquée » n'est pas implémenté |
| Pack de ressources | `res-latest` GitHub + chaîne de deltas + hachages signés par le relais | mature ; reste en l'état |
| Échelle de miroirs | liste d'hôtes GitHub uniquement avec concaténation de préfixe ghproxy ; copies dans Rust, les métadonnées Cargo, Python, le site web, le mock du webui et la CSP du relais | ne peut pas se placer devant `huggingface.co` ; la dérive n'est testée que pour une copie |
| Mobile | ONNX Runtime est une feature par défaut, donc les builds Android/iOS embarquent ONNX ; le pack decisions n'est pas embarqué | le mobile bénéficierait du même canal |
| Ligne de registre | `decisions-pack`, canal vide, déclencheur `manual` | pas de boutons vérifier/télécharger, pas d'entrée dans le registre de fraîcheur |

Cette vague **crée donc un canal** ; elle n'en migre aucun.

> **État d'implémentation.** Le canal est en service : `langyo/wowsp-d1` a publié la seq 2 (les quatre modèles ONNX, la table d'attributs et 35 rasters LOS de terrain générés à partir de l'arbre de pack `6855322b…`), vérifiés via `hf-mirror.com` et l'endpoint officiel ; le canal `ai` de l'application, la carte de réglages et les huit locales de réglages ont été livrés avec. Le tableau ci-dessus décrit l'état antérieur au canal que ce design remplace ; la table de routage portée par le pack écrase désormais la table embarquée (section 6.6).

## 3. Vue d'ensemble de l'architecture

Trois couches, chacune avec un seul rôle :

```text
  GitHub repo (source of truth)
      |  python scripts/publish_ai_models.py  (hash -> sign -> upload)
      v
  Hugging Face model repo  wowsp-d1  (generated release artifact + scripts snapshot)
      |  signed manifest.json + per-file resolve/<commit-sha>/<path>
      v
  client  commands/ai_pack.rs  --->  commands/mirror/ (MirrorContext)
      |      per-file download via download_hub        GitHub | Hugging Face | ModelScope
      v
  <cache>/decisions  (fire/move/advice/torpedo + attrs + <map>/terrain_los.npz)
```

| Décision | Choix | Pourquoi |
| --- | --- | --- |
| Source de téléchargement | Hugging Face uniquement en v1 (plus le `hf-mirror.com` intégré) ; le repli GitHub Release et ModelScope sont des fournisseurs ultérieurs | un seul chemin de publication à vérifier ; le contexte de miroir rend l'ajout d'un fournisseur peu coûteux |
| Ancrage de confiance du manifeste | manifeste auto-signé utilisant les clés Ed25519 épinglées existantes et un cliquet `seq` | Hugging Face n'expose aucun hachage officiel par actif ; un canal de hachages par relais ajouterait une étape de déploiement par publication de modèle sans assurance supplémentaire |
| Unité de transfert | un fichier par artefact, installation atomique par zone de préparation | tous les fichiers < 10 MB ; mises à jour incrémentales ; le hub prend déjà en charge la progression par segment, sha256, les plafonds, la reprise et l'annulation |
| Sélection de miroir | échelle prenant en compte le fournisseur avec mise en concurrence au démarrage à froid, endpoint collant par passe et refroidissement de santé | les hôtes officiels sont inaccessibles pour une partie du public ; l'ordre déterministe listé par l'utilisateur doit être préservé |
| Pack de ressources | inchangé, GitHub uniquement | 5.7k fichiers, la chaîne de deltas et les hachages d'actifs GitHub restent le meilleur choix |

## 4. Dépôt Hugging Face

### 4.1 Disposition

```text
wowsp-d1/                          public model repository (owner/repo TBD, see 11)
  README.md                        model card: purpose, provenance, metrics, file table, licence
  LICENSE                          Synthetic Source License 1.0 (same as the app repo)
  manifest.json                    signed runtime manifest (section 5)
  NOTICE.md                        game-data provenance and redistribution note (section 4.5)
  onnx/fire_model.onnx
  onnx/move_model.onnx
  onnx/advice_fire_model.onnx
  onnx/torpedo_model.onnx
  onnx-int8/                       optional quantized variants, never installed by default
  attrs/ship_attributes.json
  los/<mapId>/terrain_los.npz
  training/                        generated snapshot: scripts/experiments training/deployment scripts
  SOURCE.json                      {"repo","commit","generatedAt","tool":"scripts/publish_ai_models.py"}
```

`manifest.json` est le seul fichier que l'application traite comme point
d'entrée du canal. Les fichiers individuels sont aussi téléchargeables un par
un par les humains et via la table de fichiers de la fiche du modèle.

### 4.2 Règle de taille de fichier

Chaque fichier du dépôt reste **sous 10 MB** afin que les mises à jour
restent petites et incrémentales. Le Hub stocke néanmoins les blobs binaires
via Xet/LFS même sous ce seuil (un push binaire en Git simple est refusé),
donc `/resolve/` répond par une redirection CDN signée plutôt que 200 ; le
téléchargeur la suit et conserve le Range/reprise sur l'hôte final, et aucun
client Xet n'intervient. Les rasters LOS sont aujourd'hui un fichier par
carte (tous bien en dessous de la limite) ; si un futur pack devait dépasser
la limite par fichier, découper les LOS en lots numérotés qui restent chacun
en dessous. Le publicateur refuse un fichier préparé dépassant 10 MB et
affiche le chemin fautif.

### 4.3 Modèle de révision

Les révisions Hugging Face sont des commits ; les branches/tags peuvent
bouger, les SHA de commit non. La publication utilise donc deux commits :

1. téléverser les fichiers d'artefacts (poids, attrs, LOS, instantané des
   scripts) -> commit `A` ;
2. téléverser `manifest.json`, `README.md`, `LICENSE`, `NOTICE.md` et
   `SOURCE.json` avec `"revision": "A"` dans le manifeste -> commit `B`.

L'application récupère `manifest.json` depuis la tête de branche (`main`),
vérifie sa signature, puis télécharge chaque fichier depuis
`/{repo}/resolve/{A}/{path}` — un épinglage immuable. Un client qui a mis en
cache un manifeste plus ancien continue d'utiliser l'ancien commit même après
l'avancée de `main`. Les annotations (tags `models-<seq>`) sont réservées
aux humains.

### 4.4 Flux de publication et opérations

`scripts/publish_ai_models.py` (calqué sur `scripts/release_models.py`) :

1. collecter les entrées (poids, `ship_attributes.json`, répertoire LOS
   généré, instantané des scripts depuis `git archive` du commit nommé) ;
2. hacher chaque fichier, construire le manifeste signé (section 5), calculer
   le hachage d'arbre ;
3. téléverser les artefacts (commit A), puis téléverser le manifeste et les
   docs (commit B, épinglé à A) ;
4. afficher le résumé de publication (seq, sha256 du manifeste, commits HF,
   table de fichiers). `--dry-run` exécute toutes les étapes locales sans
   téléverser.

**Compte, jeton et création du dépôt.** Hugging Face n'a pas de chemin
d'écriture anonyme : publier nécessite un compte et un jeton d'écriture. Le
jeton est créé dans l'interface web (Settings -> Access Tokens, de préférence
un jeton à grains fins limité à la portée d'écriture de ce dépôt) et est
fourni via `HF_TOKEN` ou le magasin de jetons standard de l'utilisateur
(`~/.cache/huggingface/token`). Le dépôt lui-même peut être créé par le
script via `huggingface_hub.create_repo` (REST `POST /api/repos/create`),
par l'interface web, ou par la CLI optionnelle `hf repo create` — les trois
sont équivalents ; **la CLI n'est pas un prérequis**. Le publicateur utilise
l'API Python `huggingface_hub`, qui est aussi ce que l'action GitHub
officielle `huggingface/hub-sync` enveloppe ; une voie CI pourra plus tard
exécuter le même script avec `HF_TOKEN` comme secret de dépôt (jamais
versionné).

**Réalité réseau.** Seul `huggingface.co` accepte les écritures. Depuis la
Chine continentale, cet hôte n'est pas joignable directement (vérifié :
expiration de connexion), donc une exécution de publication locale nécessite
le proxy HTTP(S) du mainteneur (`HTTPS_PROXY`), ou bien la publication
s'exécute sur la CI. Le miroir est un proxy en lecture seule : les lectures à
l'exécution n'ont pas besoin de proxy, les écritures si. La vérification
après téléversement peut se faire via le miroir (section 7.8).

**Versionnage.** `seq` est un compteur de publication strictement croissant
stocké dans `manifest.json` (le publicateur avertit si la valeur ne dépasse
pas celle du manifeste actuellement publié). `version` est l'horodatage de
publication UTC ; l'identité de contenu est `treeSha256` (section 5.4).

### 4.5 Documentation et provenance

- `README.md` est une fiche de modèle : ce que fait chaque modèle, le
  contrat de l'extracteur de caractéristiques, les chiffres d'évaluation de
  `scripts/experiments/README.md` (auPRC/AUC/ECE/decile lift selon le cas),
  les formes des tenseurs d'entrée/sortie, la procédure de reproduction, les
  liens vers le commit GitHub exact et la licence.
- `SOURCE.json` enregistre le dépôt, le commit, l'heure de génération et le
  hachage d'arbre exact, afin qu'un artefact publié soit traçable jusqu'au
  code.
- `training/` est un **instantané généré** de `scripts/experiments/`
  (scripts, assistants de compilation, journal de recherche). La fiche de
  modèle précise que la source faisant autorité est le dépôt GitHub au commit
  enregistré et que l'instantané ne doit pas être modifié sur Hugging Face.
- Les corpus de replays bruts ne sont jamais publiés : ce sont des données de
  session fournies par les utilisateurs. La fiche de modèle décrit la forme du
  corpus et la base de filtrage/consentement uniquement en termes agrégés.
- `NOTICE.md` consigne que les rasters LOS sont générés à partir de la
  géométrie de carte publiée et que la table d'attributs est dérivée des
  données du jeu, et rappelle l'exigence de divulgation de la Synthetic Source
  License. Les poids sont entraînés à partir de caractéristiques dérivées des
  replays. C'est la même classe de données que le canal public `res-latest`
  expédie déjà ; publier vers un second hôte public ne change pas la licence,
  mais change la visibilité, d'où cette mention explicite (section 11,
  décision 2).

### 4.6 Politique de synchronisation

GitHub est l'unique source de vérité. Hugging Face est un artefact de
publication généré : pas de retouche manuelle, pas de seconde branche de
développement, pas de synchronisation inverse. Un changement de modèle
commence dans ce dépôt (scripts d'entraînement + artefacts commités dans les
entrées du publicateur), puis un mainteneur exécute le publicateur. Les
différences entre les deux hôtes s'expliquent donc par la provenance des
commits, non par une maintenance parallèle.

## 5. Le manifeste signé

### 5.1 Exemple

```json
{
  "format": 1,
  "seq": 7,
  "version": "2026-11-08T14:22:03Z",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "source": { "repo": "langyo/wowsp", "commit": "89abcdef0123456789abcdef0123456789abcdef" },
  "resTreeSha256": "3f2a...",
  "files": [
    { "path": "fire_model.onnx", "sha256": "8ba9...", "size": 2592543,
      "kind": "fire-two-head", "featureSet": "fire-v1", "quant": "fp32" },
    { "path": "move_model.onnx", "sha256": "bc91...", "size": 2652542,
      "kind": "move-sectors-17", "featureSet": "move-v1", "quant": "fp32" },
    { "path": "advice_fire_model.onnx", "sha256": "b98f...", "size": 2595135,
      "kind": "advice-fire-attrs", "featureSet": "advice-e24", "quant": "fp32" },
    { "path": "torpedo_model.onnx", "sha256": "a7e3...", "size": 492411,
      "kind": "torpedo-three-head", "featureSet": "torpedo-e26d", "quant": "fp32" },
    { "path": "ship_attributes.json", "sha256": "2bbd...", "size": 261507 },
    { "path": "50_Gold_harbor/terrain_los.npz", "sha256": "9c1d...", "size": 172432 }
  ],
  "treeSha256": "d41d...",
  "metrics": { "fire": { "auprc": 0.32, "auc": 0.72 } },
  "key_id": "main",
  "sig": "MEUCIQ..."
}
```

### 5.2 Champs

| Champ | Signification |
| --- | --- |
| `format` | version du schéma du manifeste (1) |
| `seq` | compteur de publication strictement croissant ; l'application refuse une valeur inférieure à la dernière qu'elle a installée |
| `version` | horodatage de publication UTC, affichage uniquement |
| `revision` | SHA de commit Hugging Face qui contient exactement les fichiers listés |
| `source` | dépôt GitHub + commit dont la publication a été générée |
| `resTreeSha256` | hachage d'arbre du pack de ressources contre lequel les rasters LOS ont été générés (optionnel ; absent si aucun LOS n'est expédié) |
| `files[].path` | chemin de destination dans `<cache>/decisions` ; chemin relatif simple, segments validés (`[A-Za-z0-9._-]`, pas de `..`, pas de séparateurs à l'intérieur d'un segment) |
| `files[].sha256` | sha256 en minuscules des octets exacts |
| `files[].size` | taille en octets, utilisée comme plancher/plafond de transfert |
| `files[].kind`, `featureSet`, `quant` | métadonnées du contrat de modèle ; requises pour les entrées `.onnx`, absentes pour les fichiers de données |
| `treeSha256` | identité de contenu : sha256 sur les lignes triées `path\0sha256\n` (formule identique au pack de ressources, afin que les mêmes outils puissent hacher les deux) |
| `metrics` | métadonnées d'affichage copiées du rapport d'entraînement |
| `key_id`, `sig` | couche de signature Ed25519 |

### 5.3 Signature et anti-retour arrière

La signature couvre le JSON canonique du manifeste **sans le membre `sig`** —
clés triées, séparateurs compacts, UTF-8 — la même forme canonique déjà
implémentée par `scripts/catalog_signing.py` et vérifiée par l'application
contre des clés publiques épinglées à la compilation
(`packages/app/tauri/res/keys/*.pub`). La signature réutilise la cérémonie
de clés de hachages de version existante ; aucune nouvelle paire de clés n'est
introduite.

L'application vérifie la signature avant d'analyser les champs, puis applique
le cliquet `seq` : un manifeste authentifié dont le seq est inférieur à celui
stocké localement est refusé (garde anti-rejeu/rétrogradation). Un miroir peut
donc au pire resservir un ancien manifeste signé ; il ne peut jamais en forger
un. Un échec de récupération du manifeste ou une signature invalide est un
échec définitif pour cette vérification — le canal n'a délibérément **aucun**
repli « accepter un manifeste de miroir non vérifié », car la charge utile est
du contenu de modèle exécutable.

### 5.4 Fraîcheur et péremption

`manifest.json` est récupéré depuis la tête de branche Hugging Face. Les
caches de miroir peuvent servir une copie périmée pendant une courte fenêtre ;
un manifeste périmé est authentique mais plus ancien, donc la vérification
soit signale « à jour » avec l'ancien seq, soit attend la vérification
suivante. L'ordre de téléversement du publicateur (artefacts d'abord,
manifeste en dernier) garantit qu'un manifeste ne nomme jamais des fichiers
qui ne sont pas déjà résolubles à sa révision épinglée. Un fichier en cache
n'est accepté que si son sha256 correspond au manifeste.

## 6. Le canal d'exécution (`ai`)

### 6.1 Registre et surface RPC

| Élément | Changement |
| --- | --- |
| ligne de registre de `resources.rs` | `decisions-pack` devient le canal `ai`, déclencheur `boot` (vérification silencieuse) + manuel, type de progression `ai-models` |
| registre d'état | ajouter `decisions-pack` à `STAMPED_ROWS` pour que `<data>/resources/decisions-pack.json` enregistre les horodatages d'installation/de vérification |
| nouvelles commandes | `ai_pack_status`, `ai_pack_check`, `ai_pack_download`, `ai_pack_cancel` ; l'effacement réutilise `clear_decisions_pack` (étendu pour supprimer l'estampille) |
| progression | `wowsp://download-progress`, type `ai-models`, une tâche par passe, segments par fichier dans `detail` |
| webui | carte Paramètres -> ressources (section 6.8), module api, `rpc.ts`, webMock, test de parité |

### 6.2 Séquence de vérification

1. Résoudre l'URL du manifeste via le contexte de miroir et récupérer
   `manifest.json` (petit fichier ; mise en concurrence au démarrage à froid,
   puis endpoint collant).
2. Vérifier la signature Ed25519 et la forme canonique ; analyser ; appliquer
   le cliquet seq.
3. Comparer `seq` / `treeSha256` avec `<cache>/.ai-version.json`
   (l'estampille vit à côté de `decisions/`, pas dedans, afin que le hachage
   d'arbre reste pur). Aucune différence -> signaler l'état actuel.
4. Lorsque le manifeste déclare des modèles que le build en cours ne peut pas
   charger (voir 6.6), marquer la publication incompatible plutôt que de la
   télécharger.

La vérification est silencieuse au démarrage derrière un TTL (24 h) et
toujours disponible depuis la carte. Elle ne télécharge jamais ; le
téléchargement reste une action de l'utilisateur.

### 6.3 Téléchargement fichier par fichier

Tous les fichiers passent par `download_hub::transfer` avec
`kind = "ai-models"` :

- les candidats viennent du contexte de miroir (fournisseur Hugging Face,
  révision épinglée depuis le manifeste), le préfixage par miroir ne
  s'applique jamais ;
- `expected_sha256` = hachage du manifeste, `min_bytes = max_bytes = size`,
  `total_hint = size`, `resume = true` avec un nom de partie par fichier ;
- l'échec d'un fichier bascule vers l'endpoint suivant pour ce fichier
  seulement ; la passe conserve dans l'arbre de préparation les octets déjà
  vérifiés ;
- la progression rapporte les octets agrégés sur la passe
  (`base_received`/`base_total`) plus `detail: {file, index, files}` ;
  l'annulation suit la portée standard du hub ;
- les fichiers sont écrits sous `<cache>/.ai-staging/<path>` ; rien ne touche
  le pack actif tant que chaque fichier n'est pas présent et vérifié.

### 6.4 Validation avant installation

Avant la bascule, dans une tâche bloquante :

1. recalculer `treeSha256` sur les fichiers préparés et le comparer au
   manifeste (tout fichier en trop/manquant fait échouer la passe) ;
2. pour chaque fichier `.onnx`, le charger via les wrappers ONNX Runtime
   existants et le classer : le type, les largeurs d'entrée et les têtes de
   sortie doivent correspondre au `kind`/`featureSet` déclaré (tir : 24 x
   `ENTITY_DIM_V2` x `GLOBAL_DIM_V2` ; déplacement : 17 classes ; conseil :
   tête routée par attributs ; torpille : bloc global `TORP_GLOBAL_DIM_V2`) ;
3. rejeter la passe si un modèle requis échoue ; les modèles optionnels
   (conseil, torpille) ne peuvent être abandonnés avec un avertissement que si
   le manifeste les marque comme optionnels. Un modèle chargé déjà en cache
   dans le processus continue de servir jusqu'au redémarrage.

Cela élimine le mode de défaillance « pack de mauvaise génération » que le
pack manuel actuel ne peut pas détecter, au prix de l'analyse de quelques
mégaoctets avant la bascule.

### 6.5 Installation, estampille et retour arrière

1. renommer `decisions` -> `.decisions-backup`, la préparation ->
   `decisions` ;
2. écrire `<cache>/.ai-version.json` avec `{schema, seq, version, revision,
   treeSha256, manifestSha256, keyId, installedAt}` ;
3. enregistrer la ligne du registre de fraîcheur ; supprimer la sauvegarde en
   cas de succès ;
4. en cas d'échec (bascule, estampille, registre), restaurer la sauvegarde et
   faire échouer la commande ; une passe annulée laisse l'ancien pack intact.

Une validation échouée, une passe plantée ou une annulation de l'utilisateur
retombe donc toujours sur le dernier bon pack. La carte propose « effacer »
dès que `decisions` existe ; la session chargée reste jusqu'au redémarrage
(comportement existant).

### 6.6 Contrat de caractéristiques

Les fichiers de modèle sont couplés aux extracteurs de caractéristiques Rust
qui reflètent les scripts d'entraînement Python. Les valeurs `featureSet` du
manifeste sont le contrat :

| Modèle | Type | Jeu de caractéristiques (v1) | Requis |
| --- | --- | --- | --- |
| fire_model.onnx | tir à deux têtes (deep sets à 24 entités) | `fire-v1` | oui |
| move_model.onnx | secteurs de déplacement à 17 classes | `move-v1` | oui |
| advice_fire_model.onnx | tête de conseil routée par attributs | `advice-e24` | non |
| torpedo_model.onnx | modèle de torpille à trois têtes | `torpedo-e26d` | non |

L'application n'accepte une publication que lorsque le jeu de caractéristiques
de chaque modèle requis figure dans son ensemble pris en charge et que celui
de chaque modèle optionnel est soit pris en charge, soit absent. Un changement
d'extracteur de caractéristiques incrémente le nom du jeu dans la même PR que
celle qui modifie l'extracteur Rust, afin qu'une application périmée ne puisse
jamais fournir les mauvais tenseurs à de nouveaux poids.

### 6.7 Rasters LOS et pack de ressources

Les rasters LOS sont générés à partir de la géométrie de carte du pack de
ressources. Quand les GLB de carte du pack changent (montée de version du jeu),
les anciens rasters décrivent l'ancien terrain. Le `resTreeSha256` optionnel
du manifeste enregistre l'arbre du pack contre lequel les rasters ont été
générés ; l'application le compare à l'estampille du pack installé et, en cas
de divergence, installe les modèles mais ignore les fichiers LOS (la recherche
par carte existante tolère déjà les rasters manquants) et invite l'utilisateur
à mettre d'abord à jour le pack de ressources. Le publicateur génère les LOS
après la publication du pack et enregistre le même hachage d'arbre.

### 6.8 Interface, i18n et mobile

- La carte Paramètres -> ressources gagne : la version actuelle (date de
  publication et suffixe de hachage d'arbre), des lignes par modèle avec
  présence/taille/préfixe sha, la couverture LOS (`x/known maps`), la taille
  totale, les boutons vérifier/télécharger/annuler, l'indication de redémarrage
  et le groupe échelle de miroirs (section 7.6).
- i18n : les 13 clés `settings.resourcesDecisions*` existantes sont étendues
  avec des chaînes vérifier/télécharger/progression/version/couverture LOS sur
  les huit locales de paramètres (en-US, zh-CN, zh-TW, ja-JP, ko-KR, fr-FR,
  es-ES, ru-RU) ; la référence de correction est `scripts/check_i18n.py`.
- Le mobile utilise le même canal (ONNX Runtime est déjà une feature par
  défaut). L'APK allégé télécharge les modèles à la demande ; embarquer une
  base de référence dans les installateurs/APK est une option ultérieure
  (section 10, PR4).
- Un build sans la feature `ai` (variante portable) ne lie pas ONNX Runtime :
  le canal est soit masqué, soit affiché comme indisponible, et ne télécharge
  jamais de modèles non chargeables.

### 6.9 Modes d'échec

| Défaillance | Comportement |
| --- | --- |
| Aucun miroir joignable / manifeste 4xx-5xx | la vérification échoue, le pack actuel continue de servir, la raison est journalisée et affichée dans la carte |
| Signature invalide / régression de seq | échec définitif ; aucune installation, aucun repli vers du contenu non vérifié |
| Écart de sha de fichier | ce candidat est écarté ; l'endpoint suivant est essayé ; la passe échoue si tous échouent |
| Échec de chargement / type / largeur du modèle | passe rejetée avant la bascule ; ancien pack restauré |
| LOS rattachés à un arbre de pack de ressources différent | modèles installés, LOS ignorés avec un avertissement explicatif |
| Disque plein / annulation | préparation nettoyée ou conservée pour reprise ; pack actif intact |
| Application mise à jour, jeu de caractéristiques incrémenté | les anciens modèles restent installés mais ne sont pas chargés par le nouveau build tant qu'une publication compatible n'est pas installée |

## 7. Le contexte de miroir

### 7.1 Difficultés actuelles

`github_mirror.rs` ne connaît que `github.com`/`api.github.com` et réécrit
avec `{prefix}/{full-url}`. Les miroirs Hugging Face substituent au contraire
la base d'endpoint et conservent le chemin ; ModelScope a un gabarit de chemin
différent. La liste intégrée est dupliquée dans l'application, les métadonnées
shun de `Cargo.toml`, `scripts/fetch_models.py`, la page de téléchargement
du site web, le mock du webui et la CSP du relais ; seule la copie Cargo est
testée contre la dérive. Six consommateurs (`update`, `model_pack`,
`data_pack`, `mod_catalog`, `changelog`, `media`) parcourent chacun leur
propre boucle.

### 7.2 Modèle de fournisseur

Nouveau module `packages/app/tauri/src/commands/mirror/` :

```rust
pub enum ProviderId { GitHub, HuggingFace, ModelScope }

pub enum Rewrite {
    UrlPrefix,                                  // GitHub: {prefix}/{official_url}
    Endpoint { template: &'static str },        // HF: {base}/{repo}/resolve/{rev}/{path}
                                                // MS: {base}/models/{repo}/resolve/{rev}/{path}
}

pub struct HfResource<'a> {
    pub repo: &'a str,      // "owner/name"
    pub revision: &'a str,  // pinned commit sha (validated as a plain segment)
    pub path: &'a str,      // repository-relative file path (validated segment by segment)
}

pub struct MirrorContext { /* config snapshot, provider ladders, health/last-good cache */ }

impl MirrorContext {
    pub fn candidates(&self, target: Target<'_>) -> Vec<Candidate>;
    pub fn probe(&self, provider: ProviderId) -> Vec<ProbeRow>;
    pub fn sticky(&self, provider: ProviderId) -> Option<Endpoint>;
}
```

Le hub de téléchargement continue de prendre des sources `Vec<String>` : la
résolution du fournisseur est une fonction pure de (config, cible). La
politique de hachage/signature reste dans chaque canal, préservant l'invariant
selon lequel une URL de miroir est un transport, jamais une identité de
contenu.

### 7.3 Matrice d'URL

| Fournisseur | Officiel | Réécriture miroir | Sonde |
| --- | --- | --- | --- |
| GitHub | `https://github.com/langyo/wowsp/releases/download/<tag>/<asset>` | `{ghproxy-prefix}/{official-url}` | page `releases/latest` du dépôt (existante) |
| Hugging Face | `https://huggingface.co/{repo}/resolve/{rev}/{path}` | `{endpoint}/{repo}/resolve/{rev}/{path}` (p. ex. `https://hf-mirror.com/...`) | épingler un petit fichier : `{endpoint}/{repo}/resolve/{rev}/manifest.json`, HEAD ou `Range: bytes=0-1023`, accepter 200/206 |
| ModelScope (ultérieur) | `https://www.modelscope.cn/models/{repo}/resolve/{rev}/{path}` | substitution d'endpoint, même gabarit | HEAD `resolve/{rev}/manifest.json` |

Les endpoints d'API Hugging Face (`/api/models/...`) ne sont jamais sur le
chemin de téléchargement ; si une sonde veut des métadonnées, elle utilise un
fichier épinglé, car le quota anonyme de l'API est bien plus serré que celui du
résolveur.

### 7.4 Sélection, santé et mise en concurrence

- L'ordre des candidats relève d'une politique par fournisseur : GitHub
  conserve l'ordre existant : endpoints utilisateur -> route officielle ->
  intégrés ; Hugging Face utilise endpoints utilisateur -> intégrés -> route
  officielle (priorité à la Chine continentale). Le panneau de paramètres
  affiche les lignes officielles, intégrées et utilisateur dans la même forme
  que l'échelle GitHub actuelle.
- **Démarrage à froid** : sonder/mettre en concurrence des requêtes de petits
  fichiers sur les candidats configurés avec des départs échelonnés (officiel
  + intégrés), la première réponse vérifiée gagne ; les perdants sont annulés.
  Cela évite le comportement actuel « officiel d'abord, attendre 8-15 s, puis
  basculer » que les utilisateurs de Chine continentale paieraient sinon
  toujours.
- **Endpoint collant par passe/fournisseur** : dès qu'un candidat répond, le
  reste de la passe (tous les fichiers) l'utilise d'abord ; les échecs
  basculent au sein de l'échelle depuis l'offset engagé (comportement du hub).
- **Cache de santé** : par endpoint, dernier résultat, latence et un court
  refroidissement après échec, limité à la session plus un endpoint
  dernier-bon persistant par fournisseur (appdata, pas une configuration
  visible par l'utilisateur). Une sonde déclenchée par l'utilisateur efface
  les refroidissements.
- Les transferts de gros fichiers continuent d'utiliser la course/bascule
  existante du hub ; le contexte ne fait qu'ordonner les sources.

### 7.5 Configuration et IPC

`network-config.toml` gagne un champ optionnel additif (camelCase comme le
reste) :

```toml
githubMirrors = ["https://ghfast.top"]
huggingfaceMirrors = ["https://hf-mirror.com", "https://hf-mirror.example"]
```

- Endpoints de base uniquement (schéma requis, https uniquement, pas de
  requête/fragment, barre oblique finale supprimée, <= 8 entrées,
  dédupliquées) ; la route officielle est implicite et jamais stockée.
- La sémantique de `githubMirrors` est inchangée ; l'ancienne chaîne unique
  `githubMirror` continue de venir s'insérer en tête.
- Une future table `providerMirrors` pourra remplacer les champs par
  fournisseur sans casser l'ancienne écriture.
- IPC : `mirror_ladder(provider)` et `mirror_probe(provider)` renvoient des
  DTO étiquetés par fournisseur ; les anciennes commandes nommées GitHub
  restent comme fines enveloppes pendant une version, afin que le test de
  parité webui/api bascule proprement.
- Le webui extrait un hook `useMirrorLadder(provider)` par fournisseur et un
  composant d'échelle/sonde partagé ; le groupe GitHub reste sur la page des
  mises à jour, le groupe Hugging Face se place à côté de la carte du modèle.

### 7.6 Catalogue d'endpoints et contrôles de dérive

Une source de vérité versionnée : `res/config/mirror-endpoints.json`
(fournisseurs -> endpoint officiel + liste d'endpoints intégrés + type de cible
de sonde). Rust l'embarque avec `include_str!` ; Python
(`fetch_models.py`), le site web et les listes d'autorisation CSP du relais le
consomment ou sont vérifiés contre lui par un nouveau
`scripts/check_mirror_endpoints.py` câblé dans la CI et `just lint` —
remplaçant la situation actuelle où seules les métadonnées shun de Cargo sont
testées. `res/config/upstream-endpoints.json` (le catalogue de santé du
transport) gagne les nouveaux hôtes afin que le repli proxy/direct et la page
de santé upstream les connaissent.

### 7.7 Comportement observé en Chine (2026-11-08, réseau du mainteneur)

| Cible | Résultat |
| --- | --- |
| `https://huggingface.co/api/models/...` | expiration de connexion (route directe inutilisable) |
| `https://hf-mirror.com/api/models/...` | 200, JSON complet de l'API Hub incluant le sha de commit |
| `hf-mirror.com/<repo>/resolve/main/<file>` | 307 -> `/api/resolve-cache/models/<repo>/<sha>/<file>` -> 200, `Accept-Ranges: bytes` |
| resolve de commit épinglé | 200 |
| fichier LFS/Xet via le miroir | 302 -> URL signée `cas-bridge.xethub.hf.co` -> 200/206 (le miroir ne stocke pas les octets du blob) |
| `www.modelscope.cn/models/<repo>/resolve/master/<file>` | 200 JSON, CDN chinois indépendant |

Voilà pourquoi l'échelle Hugging Face par défaut pour les utilisateurs de
Chine continentale met le miroir intégré en premier et l'officiel en dernier,
et pourquoi l'exécution ne dépend jamais de la joignabilité de
`huggingface.co`.

### 7.8 Mises en garde sur les miroirs

- Les miroirs tiers sont des services publics en meilleur effort, sans SLA ni
  conditions formelles (hf-mirror.com est un projet communautaire ; les
  conditions et quotas de redistribution de ModelScope ne sont pas vérifiés).
  Ce ne sont que des transports : chaque octet est vérifié par
  signature/sha256, et les endpoints sont configurables par l'utilisateur.
- Les gros fichiers peuvent être servis depuis le CDN de Hugging Face après
  une redirection signée ; le canal épingle les commits et vérifie le sha256,
  donc un fichier périmé ou erroné échoue, il n'est jamais accepté.
- Les URL CDN signées expirent (environ une heure) ; le téléchargeur les
  résout à nouveau sur 403/expiration au lieu de les mettre en cache.
- Aucun jeton n'est jamais intégré au client : dépôts publics uniquement.

## 8. Compatibilité, sécurité et invariants

- **Canal de mise à jour de l'application gelé, intact** : le programme de
  mise à jour `v*`, ses métadonnées shun et son flux de hachages ne sont pas
  modifiés par cette vague.
- **Pack de ressources inchangé** : toujours `res-latest` GitHub avec deltas
  et hachages signés ; le contexte de miroir ne change que la façon dont ses
  candidats sont produits (ordre et URL identiques pour GitHub).
- **Les anciens clients ne sont pas affectés** : aucun client existant ne
  télécharge le pack decisions, donc un nouveau canal n'ajoute aucune
  obligation de compatibilité ; le format filaire du pack de ressources n'est
  pas reformaté.
- **Compatibilité de la configuration** : les nouveaux champs TOML sont
  optionnels et ignorés par les anciens builds ; un downgrade qui répare la
  configuration les supprime (documenté), et l'application réajoute les valeurs
  par défaut à la mise à niveau suivante.
- **Invariants de sécurité** : vérité officielle uniquement pour la version et
  les hachages ; les miroirs sont des transports ; un ancrage officiel obtenu
  fait foi ; les charges utiles exécutables échouent en mode fermé ; aucun
  secret dans l'arborescence ; les fichiers ONNX sont validés (type/largeur)
  avant la bascule.
- **Modèle de menace** : comparer avec `docs/en/designs/threat-model.md` ; la
  nouvelle surface est le canal des modèles (contenu public non signé en
  transit, protégé par signature) et les endpoints de miroir tiers (transport
  en lecture seule).

## 9. Risques et atténuations

| Risque | Atténuation |
| --- | --- |
| Données LOS/attributs dérivées du jeu redistribuées publiquement (licence) | conserver le précédent du pack public actuel ; provenance `NOTICE.md` ; décision 2 de la section 11 |
| Un miroir tiers disparaît ou devient hostile | vérification signature + sha256 ; endpoints configurables par l'utilisateur ; la route officielle reste candidate |
| Limites de débit / changements de politique de Hugging Face | 46-120 requêtes par installation, bien en dessous du budget anonyme du résolveur ; conception manifeste-d'abord ; les nouvelles tentatives respectent `RateLimit`/`Retry-After` |
| Hugging Face bascule les petits fichiers vers Xet | le téléchargeur suit les redirections et Range/reprise ; si cela se produit, vérifier de bout en bout avant d'expédier un endpoint intégré |
| Dérive des caractéristiques (poids vs extracteur de caractéristiques Rust) | contrat `featureSet` explicite ; validation côté application ; un changement d'extracteur incrémente le jeu |
| Désalignement LOS/version du jeu | comparaison `resTreeSha256` ; ignorer les LOS avec une invite |
| Manifeste de miroir périmé | contenu authentifié + cliquet seq ; ordre de téléversement du publicateur ; nouvelle tentative à la vérification suivante |
| Manifeste non signé/malveillant | échec fermé ; clés Ed25519 épinglées ; aucun repli en clair |
| La publication fuit accidentellement un jeton | `HF_TOKEN` uniquement depuis l'environnement/secret CI ; grep pré-commit selon les règles du dépôt |

## 10. Déploiement progressif

Chaque étape a son propre worktree + PR selon le flux du dépôt ; **le
document de conception est livré dans les neuf locales de documentation**
(en, zh-CN, zh-TW, ja, ko, fr, es, ru, ar).

1. **PR1 — contexte de miroir (neutre en comportement).** Extraire
   `commands/mirror/`, fournisseur GitHub aux sémantiques identiques, champ de
   configuration + assainissement + enveloppes IPC, hook générique webui,
   catalogue d'endpoints et contrôle de dérive. Porte : les tests existants
   d'échelle/config/hub/upstream restent verts ; aucun changement de protocole.
2. **PR2 — fournisseur Hugging Face + publicateur.** Fournisseur HF
   (réécriture/mise en concurrence/sonde), `scripts/publish_ai_models.py`,
   gabarits de fiche de modèle et de licence, `just publish-ai-models`. Porte :
   fixtures de manifeste en dry-run, tests unitaires du fournisseur, répétition
   de publication contre un dépôt de test privé.
3. **PR3 — le canal `ai`.** `commands/ai_pack.rs`, lignes de registre/registre
   d'état, validation ONNX à l'installation, surcharge du pack `ship_attrs`,
   carte Paramètres + i18n + parité RPC/webMock, mises à jour de
   `docs/{en,zh-CN}/designs/resources.md` (lignes traduites là où la locale
   porte le fichier). Porte : répétition de bout en bout (miroir hors ligne,
   mauvais sha, mauvais ONNX, annulation, retour arrière), matrice complète
   lint/test.
4. **PR4 — optionnel.** Fournisseur/publication ModelScope, source de repli
   GitHub Release, base de référence embarquée dans les installateurs/APK, LOS
   paresseux par carte.

## 11. Décisions ouvertes

1. **Nom owner/repo Hugging Face** — DÉCIDÉ : `langyo/wowsp-d1` (public).
   Le compte et le jeton d'écriture appartiennent au mainteneur ; le
   publicateur crée le dépôt à la première utilisation.
2. **Déclaration de redistribution** pour les rasters LOS dérivés du jeu et la
   table d'attributs : les publier avec les poids sous la licence existante
   plus une notice de provenance (recommandé, cohérent avec le pack de
   ressources public), ou les tenir hors du dépôt de modèles public et ne les
   servir que via le pack GitHub de l'application.
3. **Portée de l'instantané des scripts d'entraînement** : tout
   `scripts/experiments/` (recommandé) ou un sous-ensemble sélectionné ;
   faut-il inclure le journal de recherche.
4. **Politique de mise à jour** : vérification silencieuse au démarrage
   derrière un TTL de 24 h et téléchargement manuel (recommandé), contre
   téléchargement automatique du pack d'environ 12 MB ; faut-il exposer un
   commutateur « auto-update models ».
5. **Fournisseurs secondaires** : ModelScope comme fournisseur de première
   classe (nécessite un compte, une clé et une revue des conditions) et/ou une
   source de repli GitHub Release.
6. **Artefacts optionnels** : expédier les variantes `onnx-int8/` et les
   fichiers `checkpoint.pt`, ou les poids seuls (recommandé : int8 optionnel,
   checkpoints non publiés).
