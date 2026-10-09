# Plugin de estadísticas dentro del juego — diseño de telemetría de precisión

> **Estado**: experimento concluido (2026-09-28); listo para su implementación.
> Documento complementario de la superposición: la capa de visualización sigue
> siendo la ventana transparente; este plugin es la fuente de datos dentro del
> juego que mantiene exactos los estados vivo/hundido de la superposición en
> cualquier configuración, incluida la pantalla completa exclusiva. El ORDEN
> de las filas de TAB sigue siendo una inferencia calibrada por cliente hasta
> que la sonda pueda leer el orden propio del juego dentro del motor — véase
> la regla de ordenación más abajo.

## Contexto y objetivos

La superposición de batalla en vivo hoy deduce la geometría de la tabla de
equipos de TAB capturando la pantalla (`overlay/capture.rs`,
`overlay_detect.rs`) y sondeando `GetAsyncKeyState(VK_TAB)` cada 30 ms.
Funciona, pero:

- la captura de pantalla es la capa más frágil (exclusiones de DRM/captura,
  HDR, multi-DPI, peculiaridades de ventana frente a pantalla completa);
- el sondeo de teclas no distingue «Tab mantenida» de «Tab tecleada en el
  chat de batalla»;
- el orden de las filas se deduce de un roster estático más heurísticas de
  hundimiento.

Un mod dentro del juego que se ejecuta sobre la **Mods API** oficial de
Wargaming (el canal PnFMods, sin inyección, sin escrituras en memoria) puede
observar el estado de la batalla desde dentro del cliente y entregarlo a WoWSP
a través de un puente de archivos. El mod no renderiza **nada** — la
superposición transparente sigue siendo la visualización — de modo que el
enfoque no arrastra el mantenimiento de la UI por versión del juego que mató
las ideas anteriores de «renderizar dentro del juego».

Objetivo: hacer de «telemetría del mod > inferencia por captura de pantalla >
orden estático» la cadena de prioridad para los datos de la superposición,
activada por un nuevo modo de roster `"plugin"` en `overlay_config.toml`.

## Lo que demostró el experimento

Verificado en Steam-ASIA 15.8.0 (build 13187581) y 360-CN 15.8.1 (build
13243917), varias batallas en cada uno; el artefacto de la sonda está en
`packages/ingame-plugin/src/Main.py` (se reporta como `0.1.0` para
siempre; la iteración vive únicamente en el historial de git):

| Capacidad | Mecanismo | Latencia / notas |
| --- | --- | --- |
| El mod carga en ambos reinos | `res_mods/<bin>/PnFModsLoader.py` (marcador de 0 bytes) + `PnFMods/<Mod>/Main.py`, `API_VERSION = 'API_v1.0'` | convive con los mods de Aslain |
| Módulos de la API inyectados | `events, ui, utils, battle, callbacks, dataHub, constants` son globales inyectados por el cargador; hacer `import` de ellos falla (lista de permitidos); nunca los oculte | los builtins también están en la lista de permitidos: no hay `globals()`/`eval` |
| Roster e identidad | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm | los registros son `SafeClass`: los subíndices funcionan, el protocolo dict no; itere la carga inicial de forma defensiva (el contenedor es brevemente no-dict) |
| Atribución de hundimientos | los cambios de `isAlive`, sondeados cada 1 s | validado 1:1 contra las líneas de registro `typeDeath` del propio juego, desfase ≤1 s, a lo largo de 4 batallas |
| Salud en vivo y avistamiento | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]` (`.value/.max/.isAlive`), `entity[CC.relation]` | el HP enemigo permanece en 0/0 hasta ser avistado — la misma niebla de guerra que la tabla del propio juego; un salto de 0 a un valor es en sí mismo un evento de avistamiento |
| Estado de la pantalla TAB | eventos SFM `input.tabModeIn` / `input.tabModeOut` | se dispara ≤3 ms después de la tecla; **no** se dispara con el Tab del chat — corrige de raíz toda la clase de falsos positivos |
| Cambios en el roster | `events.onPlayersListUpdated` | 14 eventos en una batalla |
| Ciclo de vida de la batalla | `sfm.battleLoadingStarted`, `request.showBattle`, `onBattleStart`, `up.exitBattle`, `window.hide(Battle)` | más granular que la aparición/eliminación del archivo tempArenaInfo |

**No disponible** (y no se necesita): los componentes de puntuación/XP por
jugador no existen en las entidades avatar, y la ruta del lado unbound
`$datahub.getCollection().getChildByPath('team.ally.sortedAlive')` no tiene
equivalente en el lado Python (`getCollection` no existe en el dataHub
inyectado).

**Regla de ordenación — INESTABLE, conocimiento por cliente; la verdad debe
venir de dentro del juego.** El orden de las filas de la tabla TAB es
cualquiera que renderice el HUD de cada cliente, y los fabricantes han
divergido de verdad (el primer modelo «orden de vehículos de arena con los
hundidos reañadidos al final» nunca fue más que la aproximación de la familia
WG — los grupos de empates que no podía resolver son lo que los chips de
puntos de #604 maquillaron). Calíbrelo por reino contra capturas de Tab
REALES, espere que cambie con cualquier actualización del cliente y trate la
descompilación de scripts solo como evidencia corroborante — nunca como
prueba. La matriz de 2026-10-09, descompilada de las instalaciones de esta
máquina (wowsdeob, `ShipSystem.add` / `AvatarSystem.__sortKeyAlive`):

- **Familia WG** (eu/na/asia comparten una build): indicador de vivo, rango
  de clase (CV < BB < CA < DD < SS < auxiliar), tier descendente, rango
  `NATION.SORT_ORDER`, nombre corto localizado del barco, `[TAG]apodo` — una
  sola cadena concatenada. La 15.8.0 en vivo se verificó 6/6 sobre una
  captura de Tab (2026-09-27), y la SIGUIENTE build (13357625, descargada el
  2026-10-06) descompila a la MISMA fórmula con el rango de nación primero —
  WG no se ha movido.
- **360-CN**: su propio Python (las builds 13243917 Y la actual 13357822)
  sigue calculando la clave de rango de nación de WG, pero el cliente
  RENDERIZA el orden por nombre localizado de barco (captura de 2026-10-07,
  9/9 pinyin) — la divergencia vive en la capa HUD/vista. La descompilación
  de scripts por tanto nunca podrá zanjar este cliente; solo cuentan las
  capturas renderizadas.
- **Lesta** (ru): también renderiza el orden por nombre localizado de barco
  (captura de 2026-10-09: Bogatyr encabezó dos filas de St. Louis contra
  `usa < russia`); su build actual (8867689) trae un contenedor `.pyc`
  cambiado que el descompilador todavía no puede abrir.

La app codifica esto como compuertas por reino sobre la clave de orden sin
conexión (el `realmUsesShipNameOrder` de utils/realms; utils/shipClass lleva
la clave en sí y la disposición estática de CN) y se niega a presentar la
inferencia como verdad del juego: sin un mapa de claves de orden que cubra
el roster, una batalla con plugin CONECTADO sigue leyendo su orden de filas
como inferido en la cabecera del panel /live (píldora de aviso + tooltip,
`features/replay/telemetryGrade.ts`).

**El final del camino SE ENTREGÓ (2026-10-09, el mismo día)** — vía los
componentes de barco, no la colección ordenada: el dataHub de ModAPI
inyectado solo exporta `getSingleEntity` / `getEntityCollections` sobre su
lista de permitidos `SYNCED` (`ModsShell/API_v_1_0/dataHub.py`
descompilado — exactamente dos exportaciones), y `'ship'` SÍ está en la
lista de permitidos. La sonda recorre pues el slot `ship` de los avatares
hasta el componente Ship de cada jugador, cuyo `sortKey` es la PROPIA
clave de Tab del cliente (`str(SORT_ORDER.index(subtype)) +
str(100 - level) + str(NATION.SORT_ORDER.index(nation)) + shortName` —
`ShipSystem.add`, build 13357625) y la lleva en la telemetría (`sortKeys`,
nombre → clave). El panel /live ordena el roster por clave +
`'[TAG]nickname'` — la misma concatenación exacta que compara
`__sortKeyAlive` — y califica la píldora como EXACTA cuando el mapa cubre
el roster en vivo, en todos los reinos (CN incluido: su reordenación en la
capa de vista, si la hay, parte de estas mismas claves; el bloque de vivos
del panel dentro del juego también ordena por ellas). Pendientes: el
comportamiento del sandbox de Lesta ante la colección 'ship' queda sin
verificar hasta una batalla real (cada lectura está protegida; un hueco
degrada esa batalla a la inferencia por reino), y una batalla con cobertura
parcial conserva el fallback calibrado — las filas verdaderas del juego y
las inferidas nunca se intercalan.

## Restricciones del sandbox (aprendidas por las malas; consérvelas en la guía de estilo del mod)

- Python es **2.7**; mantenga una sintaxis conservadora (sin f-strings; la
  sonda existente es deliberadamente compatible con 2/3).
- `open()` **no tiene modo de añadir** ('a' devuelve None en lugar de lanzar
  una excepción): reescriba los archivos completos desde búferes en memoria.
- Los archivos que faltan registran una línea de error del lado del motor
  antes de lanzar la excepción: inicialice cada buzón sondeado una vez al
  cargar (véase la inicialización previa de `manual_refresh.flag`).
- Las excepciones que escapan de un callback matan el mod en silencio: envuelva
  todo, deduplique los errores repetidos antes de registrarlos.
- `dir()` sobre los módulos inyectados devuelve `[]` (envoltorios SafeClass):
  la superficie de la API es solo la lista de nombres probados anteriormente.
- Existen dos canales de carga: la ruta clásica PnFMods 1.0 sin firmar que
  usamos, y la «ModsAPI 2.0» con validación de firma de WG (mods firmados de
  clase ModStation). Los mods comunitarios sin firmar conviven sin problemas;
  los fallos de firma de packs de terceros no son asunto nuestro.

## Arquitectura

```
┌─ game client (Mods API sandbox, no network) ─────────────┐
│ PnFMods/WoWSPStats/Main.py                               │
│  · roster poll (1 s, stable-confirm) → request.json      │
│  · entity walk → telemetry (hp/relation/alive)           │
│  · SFM events → tabMode marks, lifecycle marks           │
│  · heartbeat.json (phase port/battle, 1–2 s)             │
└──────────────┬────────────────────────────────────────────┘
               │ flat JSON files in the mod's own directory
┌──────────────┴────────────────────────────────────────────┐
│ WoWSP app (Rust, existing processes)                      │
│  · bridge reader/writer (replaces the experiment probe's │
│    companion role; same request/response protocol the    │
│    third-party reference plugin established)             │
│  · ordering engine: arena order + dead-sinking           │
│  · roster mode "plugin" in overlay_config                │
│  · health check: parse profile/python.log for the mod's  │
│    load/self-check lines (api[load] dh=True …)           │
└───────────────────────────────────────────────────────────┘
```

Archivos del puente (protocolo v1, todos en el directorio del mod):

```jsonc
// request.json — lo escribe el mod cuando el roster es estable (y se
// reescribe en cada refresco manual). El acompañante responde con filas de
// estadísticas.
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json — lo escribe WoWSP; la revision debe ser monótona por sesión;
// un archivo vacío (sin salto de línea final) significa «pendiente».
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json — se reescribe cada 1–2 s; obsoleto = mod muerto o juego
// cerrado.
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3 }

// diario de telemetría — reescritura completa de un anillo acotado por
// batalla; cada estado distinto más las marcas de eventos en una sola línea
// temporal:
{ "t": 1690000000000, "players": { "<avatarId>": { /* projection */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag — WoWSP escribe una marca nueva en ms de época para
// disparar una nueva consulta; el mod la consume dentro de una ventana de
// 10 s.
```

## Integración en el producto

1. **Instalación automática al activar**: activar la fuente de ordenación
   dentro del juego en los ajustes escribe el mod mediante la ruta existente
   de `mod_install.rs` / `mod_templates` (el marcador `PnFModsLoader.py`
   solo si no existe; solo archivos propios; instantánea + reversión;
   guardia de juego cerrado). Desactivar desinstala. Este es el
   comportamiento de registro «especial» que especificó el propietario: el
   plugin nunca aparece como un paso de instalación manual.
2. **Registro en los Discussions del propio repositorio**: publicar un hilo
   de recursos con plantilla en `langyo/wowsp/discussions` y referenciarlo
   desde una entrada de `mod-index.json` (`category`, `discussion`,
   compatibilidad `versions[].game`) para que el Mod Hub también pueda
   listarlo/verificarlo como cualquier otro mod — procedencia de primera
   parte, la misma maquinaria de catálogo (modelo de consentimiento del
   hueco G8 de mod-hub.md).
3. **Cadena de fallback**: telemetría ausente/obsoleta (heartbeat más
   antiguo que N s, `api[load] dh=False`, juego actualizado y el mod roto)
   → retroceder en silencio al pipeline de inferencia actual. La
   superposición nunca depende del mod para funcionar.

## Riesgos y mantenimiento

- La **deriva de la API de WG** es ahora el único acoplamiento (sin unbound,
  sin copias de elementos de serie). La superficie de la Mods API v1.0 ha
  sido estable de 13.x→15.8; la línea de autoverificación de la sonda hace
  que una rotura sea ruidosa y diagnosticable.
- **Cliente CN**: verificado como funcional; el cliente 360 ejecuta el mismo
  cargador de la Mods API (su registro busca `PnFModsLoader.py` de forma
  nativa). Vigile los cambios en la política anti-cheat de CN en cada
  versión mayor.
- **Rendimiento**: el sondeo cada 1 s de `getPlayersInfo` + el recorrido de
  entidades queda holgado dentro del presupuesto (los mods tipo TeamHP
  recorren entidades en cada fotograma); nunca use `callbacks.perTick` para
  esto.
- **Crecimiento del diario**: anillo acotado por batalla; envíe segmentos
  junto con la repetición si resultan útiles para el análisis posterior a la
  batalla.

## Mapa de integración en Rust (puntos de contacto exactos)

| Aspecto | Archivo (existente salvo indicación contraria) | Cambio |
| --- | --- | --- |
| Observador de archivos del puente | hermano de `commands/arena_info.rs`: nuevo `commands/ingame_bridge.rs` | vigilar con `notify` el directorio del mod; analizar heartbeat/request/journal; exponer eventos de Tauri `wowsp://ingame-*` |
| Motor de ordenación | nuevo módulo `overlay/order_source.rs` | reductor de orden de arena + hundimiento de muertos alimentado por eventos del puente; emite el orden final de filas que la superposición renderiza |
| Esquema de configuración | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster` incorpora `"plugin"` (cadena de prioridad `plugin > inferred > ocr > off`) |
| Control de la tecla de la superposición | `overlay/placement.rs` (`tab_key_down`) | cuando el puente está activo, dirigir mostrar/ocultar con las marcas `input.tabModeIn/Out` en lugar del sondeo de `GetAsyncKeyState` |
| Instalación / desinstalación | `commands/mod_install.rs` + `packages/ingame-plugin/` (nuevo subpaquete) | la plantilla pasa a ser el `Main.py` del subpaquete; instantánea + reversión; guardia de juego cerrado; limpieza de la sonda heredada |
| Comprobación de estado | `commands/ingame_bridge.rs` | analizar `profile/python.log` en busca de las líneas de autoverificación `probe … loaded` / `api[load] dh=True` del mod; exponer el estado para la interfaz de ajustes |
| Filas de estadísticas | `wg_api.rs` / `wg_api_cn.rs` existentes | sin cambios — el acompañante escribe `response.json` desde la misma búsqueda por lotes que la superposición usa hoy |

## Plan de pruebas

- **Conformidad con el sandbox**: cada cambio de `Main.py` que se envíe se
  valida contra la lista de restricciones (análisis sintáctico en py2.7, sin
  builtins bloqueados, sin aperturas en modo append, callbacks protegidos)
  más `python -m py_compile`.
- **Prueba de humo solo en puerto** (sin batalla): lance el juego, permanezca
  en el puerto ~15 s, salga; verifique `injected names=[…]`,
  `api[load] dh=True` y un heartbeat reciente en `python.log`. Este es el
  protocolo barato que mantuvo honesto el experimento — consérvelo como la
  prueba de aceptación de las instalaciones.
- **Fixtures de batalla**: un coop por reino; verifique que el diario
  contiene la instantánea del roster, ≥1 cambio de `alive` provocado por un
  hundimiento, marcas de tabMode, y que las líneas `typeDeath` de
  `python.log` coinciden 1:1 con los cambios.
- **Simulacro de fallback**: detenga la aplicación (sin acompañante);
  verifique que el tiempo de espera de ocupado de 180 s del mod se recupera
  y que la batalla siguiente sigue solicitando; corrompa el directorio del
  mod y verifique que la superposición retrocede en silencio a la inferencia.

## Plan de entrega

- **M1** — llevar a producción: trasladar las baterías de descubrimiento de
  la sonda a un flag de depuración; congelar el protocolo del puente; puente
  en Rust + motor de ordenación + modo `roster = "plugin"` conectado al
  store de la superposición.
- **M2** — interruptor en los ajustes, instalación/desinstalación
  automáticas, comprobación de estado vía python.log, lógica de fallback por
  obsolescencia.
- **M3** — registro en Discussions, entrada de catálogo, canal de
  actualización (las subidas de versión de la plantilla viajan con la
  versión de la aplicación; el propio archivo del mod cambia rara vez).
