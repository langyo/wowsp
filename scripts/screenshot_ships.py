"""Screenshot the ships page for visual verification.

Launches a headless Chromium against the running dev server (localhost:5173),
navigates to the ships route, waits for content, and captures screenshots of
both the tech-tree and list views + the sidebar.
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "shots")
OUT.mkdir(exist_ok=True)


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        # Collect console errors.
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)

        page.goto("http://localhost:5173/", wait_until="networkidle", timeout=30000)
        # The ships route (createWebHistory — plain path, not hash).
        page.goto("http://localhost:5173/ships", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(4000)  # let encyclopedia + tree render

        # Full-page shot of whatever loaded.
        page.screenshot(path=str(OUT / "01_ships_initial.png"), full_page=False)

        # Dump the current URL + a chunk of visible text to know where we are.
        url = page.url
        body_text = page.inner_text("body")[:800]
        print(f"URL: {url}")
        print(f"BODY: {body_text!r}")

        # Try to find the segmented view toggle and the nation rail to confirm
        # we're on the ships page.
        seg = page.locator(".s-segmented").count()
        rail = page.locator(".ships-view__nation-rail").count()
        tree = page.locator(".tech-tree").count()
        cards = page.locator(".ship-card").count()
        techcards = page.locator(".tech-card").count()
        print(f"segmented={seg} nation-rail={rail} tech-tree={tree} ship-cards={cards} tech-cards={techcards}")

        page.screenshot(path=str(OUT / "02_ships_tree.png"), full_page=False)

        # Switch to list view: click the second segmented option ("列表"/"List").
        opts = page.locator(".s-segmented__option")
        print(f"segmented options: {opts.count()}")
        if opts.count() >= 2:
            opts.nth(1).click()
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUT / "03_ships_list.png"), full_page=False)

        # Sidebar account row close-up.
        sidebar = page.locator(".sidebar")
        if sidebar.count():
            sidebar.screenshot(path=str(OUT / "04_sidebar.png"))

        # Console errors/warnings:
        print(f"\nconsole/warnings ({len(errors)}):")
        for e in errors[:30]:
            print(" ", e)

        browser.close()


if __name__ == "__main__":
    main()
