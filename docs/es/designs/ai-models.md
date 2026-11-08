# Distribución de modelos de IA: canal de Hugging Face y espejos multiproveedor (contrato de diseño)

> Estado: BORRADOR — el contrato de implementación para la oleada `feat/ai-models`.
> Alcance: publicar los modelos de decisión/puntuación integrados (pesos ONNX, la
> tabla de enrutamiento de atributos de buques y los rásteres LOS del terreno por
> mapa) junto con sus scripts de entrenamiento/despliegue en un repositorio público
> de modelos de Hugging Face; servirlos a los clientes a través de un nuevo canal
> de recursos `ai` firmado con descargas por archivo; y generalizar la escalera de
> espejos exclusiva de GitHub en un contexto de espejos consciente de proveedores,
> compartido por todos los recursos descargables.
>
> Fuera de alcance: el canal congelado de actualización de la app, el paquete de
> recursos `res-latest` (permanece en GitHub Releases), el propio pipeline de
> entrenamiento y la publicación del conjunto de datos de repeticiones.

## 1. Problema y objetivos

Los modelos de decisión integrados (las cabezas de puntuación de disparo/movimiento
en ONNX, el modelo de consejos enrutado por atributos, el modelo de torpedos
opcional, la tabla de enrutamiento y los rásteres de línea de visión del terreno
por mapa) **no tienen ningún canal de distribución**. Existen como salidas de
entrenamiento ignoradas por git en `scripts/experiments/out/`; el paquete
`<cache>/decisions` instalado es un directorio copiado a mano del que la app solo
puede hacer inventario y borrar. No hay script de publicación, ni manifiesto, ni
digest, ni descargador, ni sello de versión y ninguna garantía de cobertura — hoy
35 de los 96 ids de mapa conocidos llevan un ráster LOS, los dos modelos instalados
son más antiguos y aproximadamente la mitad del tamaño de las exportaciones fp32
actuales, y las ranuras de consejos/torpedos están simplemente vacías.

Al mismo tiempo, la app ya sabe servir un paquete más rico: el paquete de recursos
`res-latest` se publica desde este repositorio, se replica mediante una escalera al
estilo ghproxy para las redes de China continental, se verifica contra los digests
sha256 oficiales y se aplica de forma atómica. El canal de modelos de decisión
debería alcanzar el mismo estándar de ingeniería sin heredar las restricciones del
paquete de recursos de 1.3 GB.

Objetivos:

1. **Un artefacto público y reproducible.** Cada publicación de modelo se genera
   con un script incluido en el repositorio a partir de un commit nombrado del
   repositorio y se publica en un repositorio público de modelos de Hugging Face
   junto con sus scripts de entrenamiento y despliegue.
2. **Actualizaciones independientes de las publicaciones de la app — dentro de un
   contrato de características.** Un modelo reentrenado puede llegar a los clientes
   instalados sin una nueva compilación de la app siempre que su esquema de
   entrada/características coincida con el featurizer en ejecución; un cambio de
   esquema es, por definición, una publicación de la app.
3. **Integridad antes de la ejecución.** Los archivos de modelo se analizan y
   ejecutan con ONNX Runtime, así que el canal falla de forma cerrada: un manifiesto
   firmado fija el sha256 de cada archivo y el commit de Hugging Face, y una carga
   útil sin firmar o que no coincida nunca se instala.
4. **Accesibilidad desde China continental.** La escalera en tiempo de ejecución
   debe funcionar allí donde `huggingface.co` no es accesible (verificado desde la
   red del mantenedor) sin codificar de forma rígida un único espejo de terceros.
5. **Un único marco de espejos.** GitHub, Hugging Face y (más adelante) ModelScope
   comparten un único contexto consciente de proveedores — reescritura de
   candidatos, sondeo, selección por salud/pegajosidad y listas de endpoints con
   comprobación de deriva — en lugar de cinco copias de una lista de prefijos
   ghproxy.
6. **Sin secretos en el árbol.** Las credenciales de Hugging Face viven en el
   entorno o en el almacén de tokens del usuario; nunca en un archivo versionado.

### 1.1 Entradas medidas

| Artefacto | Origen (checkout de desarrollo) | Tamaño |
| --- | --- | --- |
| modelo de disparo (fp32, v2 ablate NONE) | `scripts/experiments/out/fire_model/v2plain_std/fp32.onnx` | 2,592,543 B |
| modelo de movimiento (fp32, 17 clases, ablate E11) | `scripts/experiments/out/move_model/node3/main/fp32.onnx` | 2,652,542 B |
| modelo de disparo de consejos (fp32, E24 enrutado por atributos) | `scripts/experiments/out/fire_model/e24_attrs/fp32.onnx` | 2,595,135 B |
| modelo de torpedos (fp32; int8 opcional) | `scripts/experiments/out/torpedo_model/final/fp32.onnx` | 492,411 B (int8 136,214 B) |
| tabla de enrutamiento de atributos de buques | `scripts/experiments/ship_attributes.json` | 261,507 B |
| rásteres LOS del terreno | salida de `bake_terrain_los.py`, un `terrain_los.npz` por mapa | 5,986-221,638 B cada uno (35 mapas instalados) |

Cada archivo queda muy por debajo del umbral de 10 MB por encima del cual Hugging
Face recomienda el seguimiento con git-xet, así que una publicación sigue siendo
Git plano: `/resolve/` responde 200 directamente y no se necesita ningún cliente
LFS/Xet (véase 7.8).

## 2. Estado actual

| Área | Hoy | Consecuencia |
| --- | --- | --- |
| Publicación de modelos | ninguna | los modelos no pueden llegar a los usuarios salvo por una copia manual |
| Paquete instalado | `<LOCALAPPDATA>/WoWSP/decisions`, copiado a mano | obsoleto/parcial; sin sello; los modelos de generación incorrecta son indetectables |
| Carga de modelos | escalera de `decision_serve`: entorno -> ranura del paquete -> salida de desarrollo; `ship_attrs` usa una tabla `include_str!` en tiempo de compilación | un cambio en la tabla de enrutamiento requiere una publicación de la app; el comentario «el paquete anula la tabla integrada» no está implementado |
| Paquete de recursos | GitHub `res-latest` + cadena de deltas + digests firmados por el relay | maduro; se queda como está |
| Escalera de espejos | lista de hosts solo de GitHub con concatenación de prefijos ghproxy; copias en Rust, metadatos de Cargo, Python, sitio web, mock del webui y CSP del relay | no puede ponerse por delante de `huggingface.co`; la deriva solo se prueba en una copia |
| Móvil | ONNX Runtime es una característica por defecto, así que las compilaciones de Android/iOS incluyen ONNX; el paquete de decisiones no se empaqueta | el móvil se beneficiaría del mismo canal |
| Fila del registro | `decisions-pack`, canal vacío, disparador `manual` | sin botones de comprobación/descarga, sin entrada en el registro de frescura |

Esta oleada, por tanto, **crea un canal**; no migra uno.

## 3. Visión general de la arquitectura

Tres capas, cada una con una tarea:

```text
  GitHub repo (source of truth)
      |  python scripts/publish_ai_models.py  (hash -> sign -> upload)
      v
  Hugging Face model repo  wowsp-ai  (generated release artifact + scripts snapshot)
      |  signed manifest.json + per-file resolve/<commit-sha>/<path>
      v
  client  commands/ai_pack.rs  --->  commands/mirror/ (MirrorContext)
      |      per-file download via download_hub        GitHub | Hugging Face | ModelScope
      v
  <cache>/decisions  (fire/move/advice/torpedo + attrs + <map>/terrain_los.npz)
```

| Decisión | Elección | Por qué |
| --- | --- | --- |
| Origen de la descarga | solo Hugging Face en v1 (más el `hf-mirror.com` integrado); el respaldo de GitHub Release y ModelScope son proveedores posteriores | una sola ruta de publicación que verificar; el contexto de espejos abarata añadir un proveedor |
| Ancla de confianza del manifiesto | manifiesto autofirmado con las claves Ed25519 fijadas existentes y un trinquete `seq` | Hugging Face no expone ningún digest oficial por activo; un canal de digests del relay añadiría un paso de despliegue por cada publicación de modelo sin ninguna garantía adicional |
| Unidad de transferencia | un archivo por artefacto, instalación atómica desde staging | todos los archivos < 10 MB; actualizaciones incrementales; el hub ya soporta progreso por segmento, sha256, límites, reanudación y cancelación |
| Selección de espejos | escalera consciente de proveedores con cobertura en arranque en frío, endpoint pegajoso por pasada y enfriamiento por salud | los hosts oficiales son inaccesibles para parte de la audiencia; debe conservarse el orden determinista indicado por el usuario |
| Paquete de recursos | sin cambios, solo GitHub | 5.7k archivos, la cadena de deltas y los digests de los activos de GitHub siguen siendo la mejor opción |

## 4. Repositorio de Hugging Face

### 4.1 Estructura

```text
wowsp-ai/                          public model repository (owner/repo TBD, see 11)
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

`manifest.json` es el único archivo que la app trata como punto de entrada del
canal. Los archivos individuales también son descargables individualmente por
humanos y por la tabla de archivos de la tarjeta de modelo.

### 4.2 Regla de tamaño de archivo

Cada archivo del repositorio se mantiene **por debajo de 10 MB** para que quede
como un blob de Git plano (`/resolve/` devuelve 200 con los bytes, sin redirección
firmada a CDN, sin reconstrucción xet). Los rásteres LOS son hoy un archivo por
mapa (todos muy por debajo del límite); si un paquete futuro superase el límite por
archivo, divida LOS en lotes numerados que cada uno se mantenga por debajo. El
publicador rechaza un archivo en staging por encima de 10 MB e imprime la ruta
infractora.

### 4.3 Modelo de revisión

Las revisiones de Hugging Face son commits; las ramas/etiquetas pueden moverse, los
SHA de commit no. Por eso la publicación usa dos commits:

1. subir los archivos del artefacto (pesos, attrs, LOS, instantánea de scripts) ->
   commit `A`;
2. subir `manifest.json`, `README.md`, `LICENSE`, `NOTICE.md` y `SOURCE.json` con
   `"revision": "A"` dentro del manifiesto -> commit `B`.

La app obtiene `manifest.json` de la cabeza de la rama (`main`), verifica su firma
y luego descarga cada archivo desde `/{repo}/resolve/{A}/{path}`: una fijación
inmutable. Un cliente que haya cacheado un manifiesto anterior sigue usando el
commit anterior incluso después de que `main` avance. Las anotaciones (etiquetas
`models-<seq>`) son solo para humanos.

### 4.4 Flujo de publicación y operaciones

`scripts/publish_ai_models.py` (modelado a partir de `scripts/release_models.py`):

1. recoger las entradas (pesos, `ship_attributes.json`, directorio de LOS generado,
   instantánea de scripts desde `git archive` del commit nombrado);
2. calcular el hash de cada archivo, construir el manifiesto firmado (sección 5),
   calcular el hash del árbol;
3. subir los artefactos (commit A) y luego subir el manifiesto y la documentación
   (commit B, fijado a A);
4. imprimir el resumen de la publicación (seq, sha256 del manifiesto, commits de HF,
   tabla de archivos). `--dry-run` ejecuta todos los pasos locales sin subir nada.

**Cuenta, token y creación del repositorio.** Hugging Face no tiene ruta de
escritura anónima: publicar requiere una cuenta y un token de escritura. El token
se crea en la interfaz web (Settings -> Access Tokens, preferiblemente un token de
grano fino limitado al alcance de escritura de este repositorio) y se suministra
mediante `HF_TOKEN` o el almacén de tokens de usuario estándar
(`~/.cache/huggingface/token`). El repositorio en sí puede crearlo el script
mediante `huggingface_hub.create_repo` (REST `POST /api/repos/create`), la interfaz
web o el CLI opcional `hf repo create` — los tres son equivalentes; **el CLI no es
un requisito previo**. El publicador usa la API de Python `huggingface_hub`, que es
también lo que envuelve la acción oficial de GitHub `huggingface/hub-sync`; un
carril de CI puede más adelante ejecutar el mismo script con `HF_TOKEN` como
secreto del repositorio (nunca versionado).

**Realidad de la red.** Solo `huggingface.co` acepta escrituras. Desde China
continental ese host no es accesible directamente (verificado: tiempo de espera de
conexión), así que una ejecución de publicación local necesita el proxy HTTP(S) del
mantenedor (`HTTPS_PROXY`), o bien la publicación se ejecuta en CI. El espejo es un
proxy de solo lectura: las lecturas en tiempo de ejecución no necesitan proxy, las
escrituras sí. La verificación tras la subida puede hacerse a través del espejo
(sección 7.8).

**Versionado.** `seq` es un contador de publicación estrictamente creciente
almacenado en `manifest.json` (el publicador avisa si el valor no supera el del
manifiesto publicado actualmente). `version` es la marca de tiempo UTC de
publicación; la identidad del contenido es `treeSha256` (sección 5.4).

### 4.5 Documentación y procedencia

- `README.md` es una tarjeta de modelo: qué hace cada modelo, el contrato del
  featurizer, los números de evaluación de `scripts/experiments/README.md`
  (auPRC/AUC/ECE/decile lift según corresponda), las formas de tensor de
  entrada/salida, cómo reproducir, enlaces al commit exacto de GitHub y la licencia.
- `SOURCE.json` registra el repositorio, el commit, la hora de generación y el hash
  exacto del árbol, de modo que un artefacto publicado es rastreable hasta el
  código.
- `training/` es una **instantánea generada** de `scripts/experiments/` (scripts,
  ayudantes de compilación, registro de investigación). La tarjeta de modelo indica
  que la fuente autoritativa es el repositorio de GitHub en el commit registrado y
  que la instantánea no debe editarse en Hugging Face.
- Los corpus de repeticiones sin procesar nunca se publican: son datos de sesión
  aportados por los usuarios. La tarjeta de modelo describe la forma del corpus y
  la base de filtrado/consentimiento solo en términos agregados.
- `NOTICE.md` registra que los rásteres LOS se generan a partir de la geometría de
  mapas publicada y que la tabla de atributos deriva de datos del juego, y reitera
  el requisito de divulgación de la Synthetic Source License. Los pesos se entrenan
  a partir de características derivadas de repeticiones. Es la misma clase de datos
  que ya distribuye el canal público `res-latest`; publicar en un segundo host
  público no cambia la licencia, pero sí cambia la visibilidad, por lo que se
  señala explícitamente (sección 11, decisión 2).

### 4.6 Política de sincronización

GitHub es la única fuente de verdad. Hugging Face es un artefacto de publicación
generado: sin ediciones manuales, sin segunda rama de desarrollo, sin
sincronización inversa. Un cambio de modelo comienza en este repositorio (scripts
de entrenamiento + artefactos confirmados en las entradas del publicador); después,
un mantenedor ejecuta el publicador. Las diferencias entre los dos hosts se
explican, por tanto, por la procedencia de los commits, no por un mantenimiento
paralelo.

## 5. El manifiesto firmado

### 5.1 Ejemplo

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
      "kind": "fire-two-head", "featureSet": "fire-v2", "quant": "fp32" },
    { "path": "move_model.onnx", "sha256": "bc91...", "size": 2652542,
      "kind": "move-sectors-17", "featureSet": "move-v2", "quant": "fp32" },
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

### 5.2 Campos

| Campo | Significado |
| --- | --- |
| `format` | versión del esquema del manifiesto (1) |
| `seq` | contador de publicación estrictamente creciente; la app rechaza un valor inferior al último que instaló |
| `version` | marca de tiempo UTC de publicación, solo para mostrar |
| `revision` | SHA del commit de Hugging Face que contiene exactamente los archivos listados |
| `source` | repositorio de GitHub + commit desde el que se generó la publicación |
| `resTreeSha256` | hash de árbol del paquete de recursos contra el que se generaron los rásteres LOS (opcional; ausente cuando no se distribuye ningún LOS) |
| `files[].path` | ruta de destino dentro de `<cache>/decisions`; ruta relativa simple, segmentos validados (`[A-Za-z0-9._-]`, sin `..`, sin separadores dentro de un segmento) |
| `files[].sha256` | sha256 en minúsculas de los bytes exactos |
| `files[].size` | tamaño en bytes, usado como suelo/techo de transferencia |
| `files[].kind`, `featureSet`, `quant` | metadatos del contrato del modelo; obligatorios para las entradas `.onnx`, ausentes para los archivos de datos |
| `treeSha256` | identidad del contenido: sha256 sobre las líneas ordenadas `path\0sha256\n` (fórmula idéntica a la del paquete de recursos, de modo que las mismas herramientas pueden hacer el hash de ambos) |
| `metrics` | metadatos de visualización copiados del informe de entrenamiento |
| `key_id`, `sig` | capa de firma Ed25519 |

### 5.3 Firma y anti-reversión

La firma cubre el JSON canónico del manifiesto **sin el miembro `sig`** — claves
ordenadas, separadores compactos, UTF-8 — la misma forma canónica que ya implementa
`scripts/catalog_signing.py` y que la app verifica contra claves públicas fijadas en
tiempo de compilación (`packages/app/tauri/res/keys/*.pub`). La firma reutiliza la
ceremonia de claves de los digests de publicación existente; no se introduce ningún
par de claves nuevo.

La app verifica la firma antes de analizar los campos y después aplica el trinquete
`seq`: un manifiesto autenticado cuyo seq sea inferior al almacenado localmente se
rechaza (protección contra repetición/degradación). Un espejo puede, como mucho,
volver a servir un manifiesto firmado antiguo; nunca puede falsificar uno. Un fallo
al obtener el manifiesto o una firma inválida es un fallo definitivo para esta
comprobación: el canal deliberadamente **no** tiene un respaldo de «aceptar un
manifiesto de espejo no verificado», porque la carga útil es contenido de modelo
ejecutable.

### 5.4 Frescura y obsolescencia

`manifest.json` se obtiene de la cabeza de la rama de Hugging Face. Las cachés de
los espejos pueden servir una copia obsoleta durante una ventana corta; un
manifiesto obsoleto es auténtico pero antiguo, así que la comprobación o bien
informa «actualizado» con el seq antiguo, o bien espera a la siguiente
comprobación. El orden de subida del publicador (primero los artefactos, el
manifiesto al final) garantiza que un manifiesto nunca nombre archivos que aún no
sean resolubles en su revisión fijada. Un archivo cacheado solo se acepta cuando su
sha256 coincide con el manifiesto.

## 6. El canal en tiempo de ejecución (`ai`)

### 6.1 Registro y superficie RPC

| Elemento | Cambio |
| --- | --- |
| fila del registro en `resources.rs` | `decisions-pack` pasa a ser el canal `ai`, disparador `boot` (comprobación silenciosa) + manual, tipo de progreso `ai-models` |
| registro de estado | añadir `decisions-pack` a `STAMPED_ROWS` para que `<data>/resources/decisions-pack.json` registre las marcas de tiempo de instalación/comprobación |
| comandos nuevos | `ai_pack_status`, `ai_pack_check`, `ai_pack_download`, `ai_pack_cancel`; el borrado reutiliza `clear_decisions_pack` (ampliado para eliminar el sello) |
| progreso | `wowsp://download-progress`, tipo `ai-models`, un trabajo por pasada, segmentos por archivo en `detail` |
| webui | Ajustes -> tarjeta de recursos (sección 6.8), módulo api, `rpc.ts`, webMock, prueba de paridad |

### 6.2 Secuencia de comprobación

1. Resolver la URL del manifiesto a través del contexto de espejos y obtener
   `manifest.json` (archivo pequeño; cobertura en arranque en frío y luego endpoint
   pegajoso).
2. Verificar la firma Ed25519 y la forma canónica; analizar; aplicar el trinquete
   de seq.
3. Comparar `seq` / `treeSha256` con `<cache>/.ai-version.json` (el sello vive
   junto a `decisions/`, no dentro, para que el hash del árbol siga siendo puro).
   Sin diferencia -> informar del estado actual.
4. Cuando el manifiesto declare modelos que la compilación en ejecución no puede
   cargar (véase 6.6), marcar la publicación como incompatible en lugar de
   descargarla.

La comprobación es silenciosa al arrancar tras un TTL (24 h) y siempre está
disponible desde la tarjeta. Nunca descarga; descargar sigue siendo una acción del
usuario.

### 6.3 Descarga por archivo

Todos los archivos viajan por `download_hub::transfer` con `kind = "ai-models"`:

- los candidatos proceden del contexto de espejos (proveedor Hugging Face, revisión
  fijada desde el manifiesto); el prefijado de espejo nunca se aplica;
- `expected_sha256` = hash del manifiesto, `min_bytes = max_bytes = size`,
  `total_hint = size`, `resume = true` con un nombre de parte por archivo;
- si un archivo falla, se recurre al siguiente endpoint solo para ese archivo; la
  pasada conserva sus bytes ya verificados en el árbol de staging;
- el progreso informa de bytes agregados a lo largo de la pasada
  (`base_received`/`base_total`) más `detail: {file, index, files}`; la cancelación
  sigue el ámbito estándar del hub;
- los archivos se escriben en `<cache>/.ai-staging/<path>`; nada toca el paquete
  activo hasta que todos los archivos estén presentes y verificados.

### 6.4 Validación antes de la instalación

Antes del intercambio, en una tarea bloqueante:

1. recalcular `treeSha256` sobre los archivos en staging y compararlo con el
   manifiesto (cualquier archivo extra o ausente hace fallar la pasada);
2. para cada archivo `.onnx`, cargarlo a través de los envoltorios existentes de
   ONNX Runtime y clasificarlo: el tipo, los anchos de entrada y las cabezas de
   salida deben coincidir con el `kind`/`featureSet` declarado (disparo: 24 x
   `ENTITY_DIM_V2` x `GLOBAL_DIM_V2`; movimiento: 17 clases; consejos: cabeza
   enrutada por atributos; torpedos: bloque global `TORP_GLOBAL_DIM_V2`);
3. rechazar la pasada si un modelo obligatorio falla; los modelos opcionales
   (consejos, torpedos) pueden descartarse con una advertencia solo cuando el
   manifiesto los marca como opcionales. Un modelo cargado ya en caché en el
   proceso sigue sirviendo hasta el reinicio.

Esto elimina el modo de fallo del «paquete de generación incorrecta» que el paquete
manual actual no puede detectar, a costa de analizar unos pocos megabytes antes del
intercambio.

### 6.5 Instalación, sello y reversión

1. renombrar `decisions` -> `.decisions-backup`, staging -> `decisions`;
2. escribir `<cache>/.ai-version.json` con `{schema, seq, version, revision,
   treeSha256, manifestSha256, keyId, installedAt}`;
3. registrar la fila del registro de frescura; eliminar la copia de seguridad al
   tener éxito;
4. ante cualquier fallo (intercambio, sello, registro), restaurar la copia de
   seguridad y hacer fallar el comando; una pasada cancelada deja el paquete
   antiguo intacto.

Por tanto, una validación fallida, una pasada que se caiga o una cancelación del
usuario siempre revierten al último paquete bueno. La tarjeta ofrece «borrar» una
vez que existe `decisions`; la sesión cargada permanece hasta el reinicio
(comportamiento existente).

### 6.6 Contrato de características

Los archivos de modelo están acoplados a los featurizers de Rust que replican los
scripts de entrenamiento en Python. Los valores `featureSet` del manifiesto son el
contrato:

| Modelo | Tipo | Conjunto de características (v1) | Obligatorio |
| --- | --- | --- | --- |
| fire_model.onnx | dos cabezas de disparo (deep sets de 24 entidades) | `fire-v2` | sí |
| move_model.onnx | sectores de movimiento de 17 clases | `move-v2` | sí |
| advice_fire_model.onnx | cabeza de consejos enrutada por atributos | `advice-e24` | no |
| torpedo_model.onnx | modelo de torpedos de tres cabezas | `torpedo-e26d` | no |

La app solo acepta una publicación cuando el conjunto de características de cada
modelo obligatorio está en su conjunto soportado y el de cada modelo opcional está
soportado o ausente. Un cambio de featurizer incrementa el nombre del conjunto en
el mismo PR que cambia el featurizer de Rust, de modo que una app obsoleta nunca
puede alimentar pesos nuevos con los tensores equivocados.

### 6.7 Rásteres LOS y el paquete de recursos

Los rásteres LOS se generan a partir de la geometría de mapas del paquete de
recursos. Cuando los GLB de mapas del paquete cambian (actualización de versión del
juego), los rásteres antiguos describen un terreno antiguo. El campo opcional
`resTreeSha256` del manifiesto registra el árbol del paquete contra el que se
generaron los rásteres; la app lo compara con el sello del paquete instalado y, en
caso de discrepancia, instala los modelos pero omite los archivos LOS (la búsqueda
por mapa existente ya tolera rásteres ausentes) y le dice al usuario que actualice
primero el paquete de recursos. El publicador genera los LOS después de publicar el
paquete y registra el mismo hash de árbol.

### 6.8 IU, i18n y móvil

- La tarjeta Ajustes -> recursos incorpora: versión actual (sufijo de fecha de
  publicación y hash de árbol), filas por modelo con presencia/tamaño/prefijo de
  sha, cobertura LOS (`x/mapas conocidos`), tamaño total, botones de
  comprobación/descarga/cancelación, aviso de reinicio y el grupo de escalera de
  espejos (sección 7.6).
- i18n: las 13 claves `settings.resourcesDecisions*` existentes se amplían con
  cadenas de comprobación/descarga/progreso/versión/cobertura de LOS en los ocho
  idiomas de ajustes (en-US, zh-CN, zh-TW, ja-JP, ko-KR, fr-FR, es-ES, ru-RU); el
  límite de corrección es `scripts/check_i18n.py`.
- El móvil usa el mismo canal (ONNX Runtime ya es una característica por defecto).
  El APK slim descarga los modelos a demanda; incluir una línea base en los
  instaladores/APK es una opción posterior (sección 10, PR4).
- Una compilación sin la característica `ai` (variante portátil) no enlaza ONNX
  Runtime: el canal se oculta o se muestra como no disponible, y nunca descarga
  modelos que no pueda cargar.

### 6.9 Modos de fallo

| Fallo | Comportamiento |
| --- | --- |
| Ningún espejo accesible / manifiesto 4xx-5xx | la comprobación falla, el paquete actual sigue sirviendo, el motivo se registra y se muestra en la tarjeta |
| Firma inválida / regresión de seq | fallo definitivo; sin instalación, sin respaldo a contenido no verificado |
| sha de archivo no coincidente | se descarta ese candidato; se prueba el siguiente endpoint; la pasada falla si todos fallan |
| Modelo no cargable/tipo/ancho no coincidente | pasada rechazada antes del intercambio; paquete antiguo restaurado |
| LOS mapeados a un árbol de paquete de recursos distinto | modelos instalados, LOS omitidos con una advertencia explicativa |
| Disco lleno / cancelación | staging limpiado o conservado para reanudar; paquete activo intacto |
| App actualizada, conjunto de características incrementado | los modelos antiguos siguen instalados, pero la nueva compilación no los carga hasta que se instale una publicación compatible |

## 7. El contexto de espejos

### 7.1 El problema actual

`github_mirror.rs` solo conoce `github.com`/`api.github.com` y reescribe con
`{prefix}/{full-url}`. Los espejos de Hugging Face, en cambio, sustituyen la base
del endpoint y conservan la ruta; ModelScope tiene una plantilla de ruta diferente.
La lista integrada está duplicada en la app, en los metadatos shun de `Cargo.toml`,
en `scripts/fetch_models.py`, en la página de descargas del sitio web, en el mock
del webui y en la CSP del relay; solo la copia de Cargo pasa pruebas de deriva. Seis
consumidores (`update`, `model_pack`, `data_pack`, `mod_catalog`, `changelog`,
`media`) recorren cada uno su propio bucle.

### 7.2 Modelo de proveedores

Nuevo módulo `packages/app/tauri/src/commands/mirror/`:

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

El hub de descargas sigue aceptando fuentes `Vec<String>`: la resolución de
proveedores es una función pura de (config, target). La política de digests/firmas
permanece en cada canal, preservando el invariante de que una URL de espejo es un
transporte, nunca una identidad de contenido.

### 7.3 Matriz de URL

| Proveedor | Oficial | Reescritura de espejo | Sonda |
| --- | --- | --- | --- |
| GitHub | `https://github.com/langyo/wowsp/releases/download/<tag>/<asset>` | `{ghproxy-prefix}/{official-url}` | página `releases/latest` del repositorio (existente) |
| Hugging Face | `https://huggingface.co/{repo}/resolve/{rev}/{path}` | `{endpoint}/{repo}/resolve/{rev}/{path}` (p. ej. `https://hf-mirror.com/...`) | fijar un archivo pequeño: `{endpoint}/{repo}/resolve/{rev}/manifest.json`, HEAD o `Range: bytes=0-1023`, aceptar 200/206 |
| ModelScope (posterior) | `https://www.modelscope.cn/models/{repo}/resolve/{rev}/{path}` | sustitución de endpoint, misma plantilla | HEAD `resolve/{rev}/manifest.json` |

Los endpoints de la API de Hugging Face (`/api/models/...`) nunca están en la ruta
de descarga; si una sonda quiere metadatos, usa un archivo fijado, porque el cupo
anónimo de la API es mucho más estrecho que el del resolver.

### 7.4 Selección, salud y cobertura

- El orden de candidatos es una política por proveedor: GitHub conserva el
  orden existente de endpoints de usuario -> ruta oficial -> integrados;
  Hugging Face usa endpoints de usuario -> integrados -> ruta oficial (con
  prioridad para China continental). El panel de ajustes muestra las filas
  oficiales, integradas y de usuario con la misma forma que la escalera de
  GitHub actual.
- **Arranque en frío**: sondear/cubrir las solicitudes de archivos pequeños entre
  los candidatos configurados con inicios escalonados (oficial + integrados); gana
  la primera respuesta verificada y los perdedores se cancelan. Esto evita el
  comportamiento actual de «primero el oficial, esperar 8-15 s y luego recurrir al
  siguiente», que los usuarios de China continental pagarían siempre.
- **Endpoint pegajoso por pasada/proveedor**: una vez que un candidato responde, el
  resto de la pasada (todos los archivos) lo usa primero; los fallos conmutan por
  error dentro de la escalera desde el desplazamiento confirmado (comportamiento
  del hub).
- **Caché de salud**: por endpoint, último resultado, latencia y un breve
  enfriamiento tras fallo, con ámbito de sesión más un endpoint bueno persistido
  por proveedor (appdata, no configuración visible al usuario). Un sondeo iniciado
  por el usuario limpia los enfriamientos.
- Las transferencias de archivos grandes siguen usando la carrera/conmutación por
  error existentes del hub; el contexto solo ordena las fuentes.

### 7.5 Configuración e IPC

`network-config.toml` incorpora un campo aditivo y opcional (camelCase como el resto):

```toml
githubMirrors = ["https://ghfast.top"]
huggingfaceMirrors = ["https://hf-mirror.com", "https://hf-mirror.example"]
```

- Solo endpoints base (esquema obligatorio, solo https, sin consulta/fragmento,
  barra final eliminada, <= 8 entradas, sin duplicados); la ruta oficial es
  implícita y nunca se almacena.
- La semántica de `githubMirrors` no se toca; la cadena heredada `githubMirror`
  sigue plegándose al principio de esa lista.
- Un futuro mapa `providerMirrors` puede reemplazar los campos por proveedor sin
  romper la forma antigua.
- IPC: `mirror_ladder(provider)` y `mirror_probe(provider)` devuelven DTOs
  etiquetados por proveedor; los antiguos comandos con nombre de GitHub permanecen
  como envoltorios finos durante una publicación para que la prueba de paridad
  webui/api cambie limpiamente.
- El webui extrae un hook `useMirrorLadder(provider)` por proveedor y un componente
  compartido de escalera/sonda; el grupo de GitHub permanece en la página de
  actualizaciones y el grupo de Hugging Face se sitúa junto a la tarjeta de modelo.

### 7.6 Catálogo de endpoints y comprobaciones de deriva

Una única fuente de verdad versionada: `res/config/mirror-endpoints.json`
(proveedores -> endpoint oficial + lista de endpoints integrados + tipo de objetivo
de sonda). Rust lo incrusta con `include_str!`; Python (`fetch_models.py`), el sitio
web y las listas de permitidos de la CSP del relay lo consumen o se comprueban
contra él mediante un nuevo `scripts/check_mirror_endpoints.py` conectado a CI y a
`just lint` — lo que sustituye la situación actual en la que solo se prueban los
metadatos shun de Cargo. `res/config/upstream-endpoints.json` (el catálogo de salud
del transporte) incorpora los nuevos hosts para que el respaldo proxy/directo y la
página de salud de upstream los conozcan.

### 7.7 Comportamiento observado en China (2026-11-08, red del mantenedor)

| Objetivo | Resultado |
| --- | --- |
| `https://huggingface.co/api/models/...` | tiempo de espera de conexión (ruta directa inutilizable) |
| `https://hf-mirror.com/api/models/...` | 200, JSON completo de la API del Hub incluyendo el sha del commit |
| `hf-mirror.com/<repo>/resolve/main/<file>` | 307 -> `/api/resolve-cache/models/<repo>/<sha>/<file>` -> 200, `Accept-Ranges: bytes` |
| resolución de commit fijado | 200 |
| archivo LFS/Xet a través del espejo | 302 -> URL firmada `cas-bridge.xethub.hf.co` -> 200/206 (el espejo no almacena los bytes del blob) |
| `www.modelscope.cn/models/<repo>/resolve/master/<file>` | 200 JSON, CDN propia de CN independiente |

Por eso la escalera predeterminada de Hugging Face para usuarios de China
continental es espejo integrado primero, oficial al final, y por eso el tiempo de
ejecución nunca depende de que `huggingface.co` sea accesible.

### 7.8 Advertencias sobre los espejos

- Los espejos de terceros son servicios públicos de mejor esfuerzo sin SLA ni
  condiciones formales (hf-mirror.com es un proyecto comunitario; los términos de
  redistribución y las cuotas de ModelScope no están verificados). Son solo
  transportes: cada byte se verifica con firma/sha256, y los endpoints son
  configurables por el usuario.
- Los archivos grandes pueden servirse desde el CDN de Hugging Face tras una
  redirección firmada; el canal fija commits y verifica sha256, así que un archivo
  obsoleto o incorrecto falla, nunca se acepta.
- Las URL firmadas del CDN caducan (alrededor de una hora); el descargador vuelve a
  resolverlas ante 403/caducidad en lugar de cachearlas.
- Nunca se incrusta ningún token en el cliente: solo repositorios públicos.

## 8. Compatibilidad, seguridad e invariantes

- **Canal de actualización de la app congelado e intacto**: el actualizador `v*`,
  sus metadatos shun y su flujo de digests no se modifican en esta oleada.
- **Paquete de recursos sin cambios**: sigue siendo `res-latest` de GitHub con
  deltas y digests firmados; el contexto de espejos solo cambia cómo se producen
  sus candidatos (orden y URL idénticos para GitHub).
- **Los clientes antiguos no se ven afectados**: ningún cliente existente descarga
  el paquete de decisiones, así que un nuevo canal no añade ninguna obligación de
  compatibilidad; el formato de cable del paquete de recursos no se reformatea.
- **Compatibilidad de configuración**: los nuevos campos TOML son opcionales y las
  compilaciones antiguas los ignoran; una degradación que saneie la configuración
  los elimina (documentado), y la app vuelve a añadir los valores predeterminados
  en la siguiente actualización.
- **Invariantes de seguridad**: verdad solo oficial para la versión y los digests;
  los espejos son transportes; un ancla oficial obtenida vincula; las cargas útiles
  ejecutables fallan de forma cerrada; sin secretos en el árbol; los archivos ONNX
  se validan (tipo/ancho) antes del intercambio.
- **Modelo de amenazas**: compárese con `docs/en/designs/threat-model.md`; la nueva
  superficie es el canal de modelos (contenido público sin firma en tránsito,
  protegido por firma) y los endpoints de espejos de terceros (transporte de solo
  lectura).

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| Datos LOS/de atributos derivados del juego redistribuidos públicamente (licencias) | mantener el precedente del paquete público actual; procedencia en `NOTICE.md`; decisión 2 de la sección 11 |
| Un espejo de terceros desaparece o se vuelve hostil | verificación de firma + sha256; endpoints configurables por el usuario; la ruta oficial sigue siendo un candidato |
| Límites de tasa / cambios de política de Hugging Face | 46-120 solicitudes por instalación, muy por debajo del presupuesto anónimo del resolver; diseño manifiesto primero; los reintentos respetan `RateLimit`/`Retry-After` |
| Hugging Face cambia los archivos pequeños a Xet | el descargador sigue redirecciones y Range/reanudación; si eso ocurre, verificar de extremo a extremo antes de distribuir un endpoint integrado |
| Deriva de características (pesos frente al featurizer de Rust) | contrato `featureSet` explícito; validación del lado de la app; un cambio de featurizer incrementa el conjunto |
| Desajuste LOS/versión del juego | comparación de `resTreeSha256`; omitir LOS con un aviso |
| Manifiesto de espejo obsoleto | contenido autenticado + trinquete seq; orden de subida del publicador; reintentar en la siguiente comprobación |
| Manifiesto sin firmar/malicioso | falla de forma cerrada; claves Ed25519 fijadas; sin respaldo en claro |
| La publicación filtra un token por accidente | `HF_TOKEN` solo desde el entorno/secreto de CI; grep pre-commit según las reglas del repositorio |

## 10. Despliegue gradual

Cada paso es su propio worktree + PR según el flujo de trabajo del repositorio;
**el documento de diseño se publica en los nueve idiomas de la documentación** (en,
zh-CN, zh-TW, ja, ko, fr, es, ru, ar).

1. **PR1 - contexto de espejos (neutral en comportamiento).** Extraer
   `commands/mirror/`, proveedor de GitHub con semántica idéntica, campo de
   configuración + saneamiento + envoltorios IPC, hook genérico del webui, catálogo
   de endpoints y comprobación de deriva. Criterio: las pruebas existentes de
   escalera/configuración/hub/upstream siguen en verde; sin cambios de cable.
2. **PR2 - proveedor de Hugging Face + publicador.** Proveedor HF
   (reescritura/cobertura/sonda), `scripts/publish_ai_models.py`, plantillas de
   tarjeta de modelo y licencia, `just publish-ai-models`. Criterio: fixtures del
   manifiesto en dry-run, pruebas unitarias del proveedor, ensayo de publicación
   contra un repositorio de prueba privado.
3. **PR3 - el canal `ai`.** `commands/ai_pack.rs`, filas de registro/registro de
   estado, validación ONNX en el momento de la instalación, anulación del paquete
   en `ship_attrs`, tarjeta de Ajustes + i18n + paridad RPC/webMock, actualizaciones
   de `docs/{en,zh-CN}/designs/resources.md` (filas traducidas donde el idioma
   tenga el archivo). Criterio: ensayo de extremo a extremo (espejo sin conexión,
   sha incorrecto, ONNX incorrecto, cancelación, reversión), matriz completa de
   lint/pruebas.
4. **PR4 - opcional.** Proveedor/publicación de ModelScope, fuente de respaldo de
   GitHub Release, línea base incluida en instaladores/APK, LOS perezoso por mapa.

## 11. Decisiones abiertas

1. **Nombre de propietario/repositorio de Hugging Face** (sugerido
   `langyo/wowsp-ai`, público). La cuenta y el token de escritura son propiedad del
   mantenedor; el publicador puede crear el repositorio.
2. **Declaración de redistribución** para los rásteres LOS derivados del juego y la
   tabla de atributos: publicarlos junto con los pesos bajo la licencia existente
   más un aviso de procedencia (recomendado, coherente con el paquete de recursos
   público), o mantenerlos fuera del repositorio público de modelos y servirlos solo
   a través del paquete de GitHub de la app.
3. **Alcance de la instantánea de scripts de entrenamiento**: todo
   `scripts/experiments/` (recomendado) o un subconjunto curado; si incluir el
   registro de investigación.
4. **Política de actualización**: comprobación silenciosa al arrancar tras un TTL de
   24 h y descarga manual (recomendado) frente a la descarga automática del paquete
   de ~12 MB; si exponer un interruptor de «actualizar modelos automáticamente».
5. **Segundos proveedores**: ModelScope como proveedor de primera clase (requiere
   cuenta, clave y revisión de términos) y/o una fuente de respaldo de GitHub
   Release.
6. **Artefactos opcionales**: distribuir las variantes `onnx-int8/` y los archivos
   `checkpoint.pt`, o solo los pesos (recomendado: int8 opcional, checkpoints no
   publicados).
