# Usage Telemetry Notice

**Effective for WoWSP 0.4 and later.**

WoWSP collects a minimal amount of usage telemetry to understand which
features are used and to guide future development. This notice describes
exactly what is collected, what is never collected, and how it is processed.

## What we collect

- **Interface language.** The language your operating system reports, so we
  know which of the app's UI locales are actually used. No other input or
  preference is derived from it.
- **Which pages of the app are opened** (route-level page views, e.g. the
  dashboard or the replay view).
- **Approximate region** derived from IP address (country level), and the
  rough count of active installs per day. The full IP address itself is
  never stored.

## What we never collect

- Personal identifying information: no names, no e-mail addresses, no game
  account identifiers.
- The content of your replays, your player nickname, or any in-game data
  tied to your account.
- File system contents, configuration values, or anything you type into the
  app.

## How it is processed

Telemetry is delivered to Google Analytics and retained under Google's
standard data-processing terms. Data is aggregated for feature-usage
statistics only; it is never sold, shared with third parties for marketing,
or used to build individual profiles.

## Disabling telemetry

The desktop build restricts telemetry to the feature-usage signals above and
no collection happens before you complete the first-run wizard. Because the
app is fully open source, the telemetry code paths can be reviewed in the
repository at any time.
