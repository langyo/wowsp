<h1 align="center">WoWSP</h1>

<p align="center"><strong>Panel de batalla gratuito y de código abierto para World of Warships — revisión de replays, superposición de alineaciones dentro del juego y consulta de estadísticas, para Windows.</strong></p>

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
[Français](../../fr/guides/README-wowsp.md) ·
**Español** ·
[Русский](../../ru/guides/README-wowsp.md) ·
[العربية](../../ar/guides/README-wowsp.md)

</div>

![Panel de control de WoWSP](../screenshots/dashboard.webp)

> [!IMPORTANT]
> **WoWSP es completamente gratuito y de código abierto, y se distribuye únicamente a través de las [GitHub Releases](https://github.com/langyo/wowsp/releases) oficiales. Cualquiera que cobre dinero por él no es el autor: no pagues; si ya lo has hecho, solicita un reembolso y denuncia al vendedor.**

WoWSP es un panel de escritorio para **World of Warships** en Windows. Detecta automáticamente tu instalación del juego (lanzador de Wargaming, Steam, Lesta o 360) y funciona en dos modos:

- **Revisión independiente** — abre cualquier `.wowsreplay` y vuelve a ver la partida en un mapa 3D holográfico: la trayectoria de cada buque, los proyectiles, los torpedos y los aviones, además de los resultados de batalla de cada jugador, sin necesidad de iniciar el juego.
- **Superposición dentro del juego** — mientras el juego está en marcha, mantén pulsado `Tab` para ver la alineación y las estadísticas de ambos equipos superpuestas sobre la partida; la superposición se vuelve a anclar con cada pulsación.

Además de estos dos modos, también te ofrece:

- Consulta de estadísticas de jugadores y clanes con tarjetas de carrera tipo water-meter.
- Una enciclopedia de buques con el árbol tecnológico completo, las especificaciones y el visor de blindaje.
- Un centro de mods y recursos para los mods populares de la comunidad.
- Una aplicación complementaria de Android que extrae los replays directamente de tu equipo por Wi-Fi, o desde cualquier lugar mediante un código de emparejamiento de seis dígitos.

## Descarga

Windows 10/11 — descarga el último `WoWSP_<version>_x64-setup-webview2.exe` desde [GitHub Releases](https://github.com/langyo/wowsp/releases/latest) (WebView2 va incluido), o usa la [página de descarga](https://wowsp.langyo.xyz/download) con espejos si GitHub te resulta lento en tu zona. La edición de Android se compila a partir del código fuente; consulta la [guía de compilación](building.md).

Las capturas de pantalla de todas las vistas, en todos los idiomas de la interfaz, están en la [galería del sitio web](https://wowsp.langyo.xyz/#gallery).

## Documentación

La arquitectura, las notas de diseño y las guías se encuentran en [`docs/`](../../) en nueve idiomas (inglés y 简体中文 completamente traducidos), compiladas con [lagrange](https://github.com/celestia-island/lagrange). WoWSP envía una telemetría de uso anónima y mínima — lo que se recopila (y lo que nunca se recopila) se detalla en el [aviso de telemetría](../license/usage-telemetry.md).

## Comentarios y créditos

Errores y comentarios de las pruebas: grupo de QQ **1125770228**, o el formulario de comentarios del [sitio web](https://wowsp.langyo.xyz). El análisis de replays y los principios de detección del juego están adaptados de [ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar); la shell del frontend y la infraestructura de compilación están adaptadas de [shittim-chest](https://github.com/celestia-island/shittim-chest).

## Licencia

WoWSP se distribuye bajo la **Synthetic Source License 1.0** ([texto completo](https://github.com/langyo/wowsp/blob/master/LICENSE)) — otorga permisos equivalentes a los de Apache-2.0 para una base de código sustancialmente generada por IA, cuya única obligación adicional es mantener el aviso de divulgación de generación por IA en cada copia y obra derivada. La instantánea de [wows-toolkit](https://github.com/langyo/wowsp/tree/master/packages/tools/wowsunpack-vendor) integrada en el repositorio y el worker independiente [pairing-relay](https://github.com/langyo/wowsp/tree/master/packages/pairing-relay) conservan sus licencias **MIT** originales.
