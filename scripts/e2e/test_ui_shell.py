"""Browser smoke tests: the app shell boots against the FastAPI mock and
the sidebar navigation works. Self-contained — the conftest boots the
mock backend AND the vite dev server (unless VITE_URL points at one
already), so `python -m pytest scripts/e2e -m ui` is the whole recipe.
"""
from __future__ import annotations

import re

import pytest
from playwright.sync_api import expect


@pytest.mark.ui
def test_shell_boots_with_sidebar_navigation(page):
    """Boot-complete marker: the sidebar nav is visible and carries the
    core section links (dashboard / lookup / ships at minimum)."""
    nav = page.locator("nav.sidebar__nav")
    expect(nav).to_be_visible()
    links = page.locator("nav.sidebar__nav a.sidebar__link")
    expect(links.first).to_be_visible()
    assert links.count() >= 3, f"core nav rows missing (got {links.count()})"


@pytest.mark.ui
def test_navigation_switches_the_active_view(page):
    """Clicking a nav row routes the shell: the lookup link navigates to
    /lookup and its own row takes the active class."""
    lookup = page.locator("nav.sidebar__nav a.sidebar__link[href='/lookup']")
    expect(lookup).to_be_visible()
    lookup.click()
    page.wait_for_url(re.compile(r"/lookup$"))
    expect(lookup).to_have_class(re.compile(r"\bis-active\b"))


@pytest.mark.ui
def test_dashboard_is_the_default_route(page):
    """A fresh boot lands on the dashboard (the router's root) with the
    main content region mounted beside the sidebar."""
    from urllib.parse import urlparse

    expect(page.locator("main.app-shell__main")).to_be_visible()
    assert urlparse(page.url).path in ("/", "/dashboard"), page.url
