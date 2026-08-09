export default {
  nav: {
    features: "Features",
    download: "Download",
    docs: "Docs",
    github: "GitHub",
  },
  hero: {
    tagline: "Replay review & in-game overlay for World of Warships",
    lede: "Watch any .wowsreplay on a holographic 3D map without launching the game. Or run WoWSP as a mod that overlays both teams' rosters while you play.",
    download: "Download for Windows",
    docs: "Read the docs",
    github: "Source on GitHub",
    version: "Initial release coming soon",
  },
  features: {
    title: "Two modes, one panel",
    replay: {
      title: "Standalone replay review",
      desc: "Auto-detects your game install, parses .wowsreplay files, and renders every ship on a holographic 3D map — no game launch required.",
    },
    overlay: {
      title: "In-game overlay",
      desc: "Installs as a mod that launches with the game. A transparent overlay shows both teams, visible only while you hold Tab.",
    },
    stats: {
      title: "Stats & insights",
      desc: "Per-ship stats, ranked seasons, player lookups and performance trends from the Wargaming public API.",
    },
    viewer: {
      title: "3D ship viewer",
      desc: "Browse the roster as low-poly holographic models — rotate, zoom, inspect armor.",
    },
  },
  download: {
    title: "Download WoWSP",
    lede: "Windows x64 · WebView2 runtime is installed automatically.",
    install: "Installer (NSIS)",
    portable: "Portable / green build",
    modesTitle: "Three ways to run",
    modeInstallTitle: "Install to this PC",
    modeInstallDesc: "Standard per-user install with start-menu shortcut and auto-updates. Recommended.",
    modeUsbTitle: "USB drive (internet-cafe)",
    modeUsbDesc: "Portable copy on a USB stick — no registry entries, all data stays on the drive. Ideal for shared PCs.",
    modeGreenTitle: "Run directly (green software)",
    modeGreenDesc: "Extract anywhere and run as a standalone copy — isolated from your main install. Great for debugging or sandboxing.",
    assets: "Release assets",
    notes: "All assets are published on GitHub Releases.",
  },
  footer: {
    license: "Licensed under SySL-1.0",
    made: "Built with Rust, Vue 3, Tauri 2 and Three.js",
  },
} as const;
