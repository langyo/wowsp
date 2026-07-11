"""Smoke test: the WoWSP home view renders and links to the two modes.

Requires the Vite dev server running at VITE_URL (default
http://localhost:5173) and the mock backend at the `mock_url` fixture. Run with:

    VITE_URL=http://localhost:5173 python -m pytest scripts/e2e/test_ui_home.py \
        -m ui --browser chromium
"""
from __future__ import annotations

import os

import pytest
from helpers.page_objects.home import HomePage

VITE_URL = os.environ.get("VITE_URL", "http://localhost:5173")


@pytest.mark.ui
def test_home_title_visible(page):
    home = HomePage(page)
    home.goto(VITE_URL)
    expect = page.expect
    with expect:
        assert home.title.is_visible()


@pytest.mark.ui
def test_home_has_both_modes(page):
    home = HomePage(page)
    home.goto(VITE_URL)
    assert home.replay_link.count() == 1
    assert home.overlay_link.count() == 1
