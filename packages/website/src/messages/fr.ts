export default {
  nav: {
    "language": "Langue",
    features: "Fonctionnalités",
    download: "Télécharger",
    docs: "Documentation",
    github: "GitHub",
  },
  hero: {
    badge: "Open source · Windows x64",
    tagline: "Analyse de replays et overlay en jeu pour World of Warships",
    lede: "Regardez n'importe quel .wowsreplay sur une carte holographique 3D sans lancer le jeu. Ou installez WoWSP comme mod pour superposer les rosters des deux équipes pendant que vous jouez.",
    download: "Télécharger pour Windows",
    docs: "Lire la documentation",
    github: "Source sur GitHub",
    version: "Première version officielle bientôt",
    ships: "1 200+ modèles de navires",
    maps: "Replays en 3D",
    overlay: "Overlay Tab en bataille",
  },
  features: {
    title: "Deux modes, un seul panneau",
    replay: {
      title: "Analyse de replay autonome",
      desc: "Détecte automatiquement l'installation du jeu, analyse les fichiers .wowsreplay et affiche chaque navire sur une carte holographique 3D — sans lancer le jeu.",
    },
    overlay: {
      title: "Overlay en jeu",
      desc: "S'installe comme un mod qui se lance avec le jeu. Un overlay transparent affiche les deux équipes, visible uniquement lorsque vous maintenez Tab.",
    },
    stats: {
      title: "Statistiques et analyses",
      desc: "Statistiques par navire, saisons classées, recherche de joueurs et tendances de performance via l'API publique Wargaming.",
    },
    viewer: {
      title: "Visionneuse de navires 3D",
      desc: "Parcourez la flotte en modèles holographiques low-poly — rotation, zoom, inspection de l'armure.",
    },
  },
  download: {
    title: "Télécharger WoWSP",
    lede: "Windows x64 · Le runtime WebView2 est installé automatiquement.",
    install: "Installeur (NSIS)",
    portable: "Version portable / verte",
    modesTitle: "Trois façons de l'exécuter",
    modeInstallTitle: "Installer sur ce PC",
    modeInstallDesc: "Installation standard par utilisateur avec raccourci menu Démarrer et mises à jour automatiques. Recommandé.",
    modeUsbTitle: "Clé USB (mode cybercafé)",
    modeUsbDesc: "Copie portable sur une clé USB — aucune entrée de registre, toutes les données restent sur la clé. Idéal pour les PC partagés.",
    modeGreenTitle: "Exécution directe (logiciel vert)",
    modeGreenDesc: "Extrayez n'importe où et exécutez en tant que copie autonome — isolé de votre installation principale. Parfait pour le débogage.",
    assets: "Ressources de sortie",
    notes: "Toutes les ressources sont publiées sur GitHub Releases.",
  },
  footer: {
    license: "Sous licence SySL-1.0",
    made: "Conçu avec Rust, Vue 3, Tauri 2 et Three.js",
  },
} as const;
