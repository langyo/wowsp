# Aviso de telemetría de uso

**Vigente a partir de WoWSP 0.4.**

WoWSP recoge una cantidad mínima de telemetría de uso para saber qué funciones se utilizan realmente y orientar el desarrollo futuro. Este aviso describe exactamente qué se recoge, qué nunca se recoge y cómo se tratan los datos.

## Qué recogemos

- **El idioma de la interfaz.** El idioma que informa el sistema operativo, para saber qué idiomas de la interfaz se usan realmente. No se deduce ningún otro dato ni preferencia de ello.
- **Qué páginas de la aplicación se abren** (vistas de página a nivel de ruta, por ejemplo el panel principal o la vista de repeticiones).
- **Una región aproximada** deducida de la dirección IP (a nivel de país) y el recuento aproximado de instalaciones activas por día. La dirección IP completa nunca se almacena.

## Qué nunca recogemos

- Información personal identificable: ni nombres, ni direcciones de correo, ni identificadores de cuenta de juego.
- El contenido de tus repeticiones, tu apodo de jugador, o cualquier dato del juego vinculado a tu cuenta.
- El contenido del sistema de archivos, los valores de configuración, o cualquier cosa que escribas en la aplicación.

## Cómo se tratan los datos

La telemetría se envía a Google Analytics y se conserva conforme a las condiciones estándar de tratamiento de datos de Google. Los datos se agregan únicamente con fines de estadísticas de uso de funciones; nunca se venden, no se comparten con terceros con fines de marketing ni se usan para crear perfiles individuales.

## Desactivar la telemetría

La versión de escritorio limita la telemetría a las señales de uso descritas arriba y no se realiza ninguna recogida antes de que completes el asistente de primer inicio. Como la aplicación es totalmente de código abierto, las rutas de código de la telemetría pueden revisarse en el repositorio en cualquier momento.
