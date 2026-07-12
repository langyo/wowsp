/**
 * Auto-interaction test harness. Triggered by `?autotest=1` in the URL.
 *
 * Drives real user interactions (clicks, input, tab switches, theme/wallpaper
 * toggles) via DOM APIs, then captures a screenshot after each interaction
 * to verify the result visually. This is NOT a headless unit test — it runs
 * against the live Tauri webview and captures real pixels.
 *
 * Test flows:
 *   1. Static page captures (all 5 routes).
 *   2. Lookup: type a nickname → click search → wait → capture StatsCard.
 *   3. Ships: click first card → switch 4 tabs → capture each.
 *   4. Settings: click About → capture AboutModal.
 *   5. Settings: toggle dark mode → capture. Toggle wallpaper → capture.
 */
import type { Router } from "vue-router";
import { api } from "@/api";

const TAG = "[autotest]";

async function run(router: Router): Promise<void> {
  log("starting interaction test suite");

  // ── Phase 1: static page captures ──────────────────────────────────
  await sleep(2500); // let theme + sidebar settle
  const routes = [
    { path: "/", name: "01-dashboard" },
    { path: "/lookup", name: "02-lookup" },
    { path: "/ships", name: "03-ships" },
    { path: "/replay", name: "04-replay" },
    { path: "/settings", name: "05-settings" },
  ];
  for (const r of routes) {
    await router.push(r.path);
    await sleep(2000);
    await capture(r.name);
  }

  // ── Phase 2: lookup search → StatsCard ─────────────────────────────
  await router.push("/lookup");
  await sleep(1500);
  await capture("06-lookup-empty");

  // Type a known public nickname into the search input.
  const input = document.querySelector<HTMLInputElement>(".lookup-view__input");
  const realmSelect = document.querySelector<HTMLSelectElement>(".lookup-view__realm");
  const searchBtn = document.querySelector<HTMLButtonElement>(".lookup-view__search button, .s-btn");

  if (input && searchBtn) {
    // Simulate user typing.
    input.focus();
    input.value = "iKan";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (realmSelect) {
      realmSelect.value = "asia";
      realmSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(500);
    log("clicking search button");
    searchBtn.click();
    // WG API call takes 2-5 seconds.
    await sleep(6000);
    await capture("07-lookup-search-result");
    // Verify StatsCard rendered.
    const card = document.querySelector(".stats-card");
    if (card) {
      log("✓ StatsCard rendered after search");
    } else {
      log("✗ StatsCard NOT found after search (may be hidden profile or API error)");
    }
  } else {
    log("✗ lookup input/search button not found");
  }

  // ── Phase 3: ship card → detail modal 4 tabs ──────────────────────
  await router.push("/ships");
  await sleep(3000); // encyclopedia may still be loading
  await capture("08-ships-loaded");

  const firstCard = document.querySelector<HTMLElement>(".ship-card");
  if (firstCard) {
    log("clicking first ship card");
    firstCard.click();
    await sleep(2000); // modal open + (lazy gameparams/trend load)
    await capture("09-ship-detail-specs");

    // Switch to Armor tab.
    const tabs = document.querySelectorAll<HTMLButtonElement>(".ship-detail__tab");
    if (tabs.length >= 4) {
      tabs[1].click(); // Armor & Ballistics
      await sleep(1500);
      await capture("10-ship-detail-armor");

      tabs[2].click(); // My Stats
      await sleep(1500);
      await capture("11-ship-detail-mystats");

      tabs[3].click(); // Community
      await sleep(1000);
      await capture("12-ship-detail-community");

      tabs[0].click(); // back to Specs
      await sleep(500);
    }

    // Close modal (click overlay or close button).
    const closeBtn = document.querySelector<HTMLButtonElement>(".s-modal__close");
    if (closeBtn) {
      closeBtn.click();
      await sleep(800);
    }
    log("✓ ship detail modal tested");
  } else {
    log("✗ no ship card found to click");
  }

  // ── Phase 4: Settings → About modal ───────────────────────────────
  await router.push("/settings");
  await sleep(1500);
  const aboutBtn = document.querySelector<HTMLButtonElement>(".settings-view__about-btn");
  if (aboutBtn) {
    log("clicking About button");
    aboutBtn.click();
    await sleep(2000); // modal open + version fetch
    await capture("13-about-modal");

    // Verify AboutModal content.
    const aboutModal = document.querySelector(".about-modal");
    if (aboutModal) {
      log("✓ AboutModal rendered");
    } else {
      log("✗ AboutModal NOT found");
    }

    // Close.
    const closeBtn = document.querySelector<HTMLButtonElement>(".s-modal__close");
    if (closeBtn) closeBtn.click();
    await sleep(800);
  } else {
    log("✗ About button not found");
  }

  // ── Phase 5: theme mode toggle → dark ─────────────────────────────
  const modeButtons = document.querySelectorAll<HTMLButtonElement>(".settings-view__mode");
  if (modeButtons.length >= 2) {
    log("switching to dark mode");
    modeButtons[1].click(); // Dark
    await sleep(1500); // theme transition
    await capture("14-settings-dark-mode");

    // Switch back to auto.
    modeButtons[0].click();
    await sleep(1000);
    log("✓ theme mode toggle tested");
  }

  // ── Phase 6: wallpaper toggle ─────────────────────────────────────
  const wallpaperBtns = document.querySelectorAll<HTMLButtonElement>(".settings-view__wallpaper");
  if (wallpaperBtns.length >= 2) {
    log("switching wallpaper to solid-black");
    wallpaperBtns[1].click(); // Solid black
    await sleep(1500);
    await capture("15-settings-wallpaper-black");

    // Back to auto.
    wallpaperBtns[0].click();
    await sleep(1000);
    log("✓ wallpaper toggle tested");
  }

  log("interaction test suite complete");
}

async function capture(name: string): Promise<void> {
  try {
    const path = await api.captureMainWindow("");
    log(`${name} → ${path}`);
    // Rename the file to include our test name for easier identification.
    // The screenshot command saves to screenshot-<timestamp>.png; we can't
    // rename from here, but the log maps timestamp → test name.
  } catch (e) {
    log(`${name} FAILED: ${(e as Error).message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`${TAG} ${msg}`);
}

/** Expose the test runner as window.__wowspAutoTest__ so the Rust shell can
 *  trigger it via eval (bypassing URL query-param issues). Safe to call
 *  multiple times — only the first exposure sticks. */
export function exposeAutoTest(router: Router): void {
  const w = window as unknown as { __wowspAutoTest__?: () => void; __wowspAutoTestDone__?: boolean };
  if (!w.__wowspAutoTest__) {
    w.__wowspAutoTest__ = () => {
      if (w.__wowspAutoTestDone__) return; // guard against double-run
      w.__wowspAutoTestDone__ = true;
      void run(router);
    };
  }
}

/** Start the test runner immediately (used when ?autotest=1 is in the URL). */
export function startAutoTest(router: Router): void {
  exposeAutoTest(router);
  const w = window as unknown as { __wowspAutoTest__?: () => void };
  w.__wowspAutoTest__?.();
}
