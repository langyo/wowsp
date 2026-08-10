export default {
  nav: {
    "language": "Idioma",
    features: "Características",
    download: "Descargar",
    docs: "Documentación",
    github: "GitHub",
  },
  hero: {
    badge: "Código abierto · Windows x64",
    tagline: "Análisis de repeticiones y superposición en el juego para World of Warships",
    lede: "Mira cualquier .wowsreplay en un mapa holográfico 3D sin iniciar el juego. O instala WoWSP como un mod que superpone las listas de ambos equipos mientras juegas.",
    download: "Descargar para Windows",
    docs: "Leer la documentación",
    github: "Código en GitHub",
    version: "El primer lanzamiento oficial llega pronto",
    ships: "Más de 1.200 modelos de barcos",
    maps: "Repeticiones en 3D",
    overlay: "Superposición Tab en batalla",
  },
  features: {
    title: "Dos modos, un solo panel",
    replay: {
      title: "Análisis de repetición autónomo",
      desc: "Detecta automáticamente tu instalación del juego, analiza archivos .wowsreplay y muestra cada barco en un mapa holográfico 3D — sin iniciar el juego.",
    },
    overlay: {
      title: "Superposición en el juego",
      desc: "Se instala como un mod que se inicia con el juego. Una superposición transparente muestra ambos equipos, visible solo mientras mantienes Tab.",
    },
    stats: {
      title: "Estadísticas e información",
      desc: "Estadísticas por barco, temporadas clasificatorias, búsquedas de jugadores y tendencias de rendimiento de la API pública de Wargaming.",
    },
    viewer: {
      title: "Visor de barcos 3D",
      desc: "Explora la flota como modelos holográficos low-poly — gira, acerca, inspecciona el blindaje.",
    },
  },
  download: {
    title: "Descargar WoWSP",
    lede: "Windows x64 · El runtime WebView2 se instala automáticamente.",
    install: "Instalador (NSIS)",
    portable: "Versión portable / verde",
    modesTitle: "Tres formas de ejecutarlo",
    modeInstallTitle: "Instalar en este PC",
    modeInstallDesc: "Instalación estándar por usuario con acceso directo en el menú Inicio y actualizaciones automáticas. Recomendado.",
    modeUsbTitle: "Unidad USB (modo cibercafé)",
    modeUsbDesc: "Copia portable en una memoria USB — sin entradas de registro, todos los datos permanecen en la unidad. Ideal para PC compartidos.",
    modeGreenTitle: "Ejecutar directamente (software verde)",
    modeGreenDesc: "Extrae en cualquier lugar y ejecuta como copia independiente — aislado de tu instalación principal. Ideal para depuración.",
    assets: "Recursos del lanzamiento",
    notes: "Todos los recursos se publican en GitHub Releases.",
  },
  footer: {
    license: "Bajo licencia SySL-1.0",
    made: "Construido con Rust, Vue 3, Tauri 2 y Three.js",
  },
} as const;
