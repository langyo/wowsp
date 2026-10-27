"""Live-battle roster alignment e2e: /live's roster densities must both land
their stat cells on the shared column header's tracks.

The user-visible contract this guards: the roster column header is ONE
template — the configured stats columns' order and spacing — and the compact
rows and the full rows both use it. The full density may only add the
ship-meta strip in the middle of each row; it must never move the stat
columns off their header cells, in either roster, with the career-seal slot
reserved or dropped. Compact rows are the shipped default for a fresh
profile; the full density is one persisted pref flip away.

Runs entirely against the FastAPI mock backend (the session fixture boots
mock + Vite) — no game client is ever involved (AGENTS.md section 0). The
mock serves a two-team sample arena roster, enough for a real /live panel.
"""
from __future__ import annotations

import json

import pytest
from playwright.sync_api import expect

PREFS_KEY = "wowsp-stats-prefs"
VIEWPORT = {"width": 1760, "height": 1020}
#: Right-edge tolerance between a row cell and its header cell: sub-pixel
#: layout rounding only, never a real column shift.
TOLERANCE_PX = 1.5
#: The four shipped global columns (winrate / PR / battles / avg damage).
CONFIGURED_COLUMNS = 4

BASE_PREFS = {
    "prEnabled": True,
    "prAlgo": "winrate",
    "sealsEnabled": True,
    "localizedTiers": True,
    "weightedTeamWr": True,
    "liveRosterCompact": True,
    "liveRosterPrTint": True,
    "postbattleRosterFull": False,
    "teamAvgEnabled": False,
    "sealDisabled": {},
    "overlayColumns": [
        {"scope": "global", "metric": "winrate"},
        {"scope": "global", "metric": "pr"},
        {"scope": "global", "metric": "battles"},
        {"scope": "global", "metric": "damage"},
    ],
    "overlayBattleScope": "follow",
}

MEASURE_JS = r"""
() => {
  const cols = [...document.querySelectorAll('.live-battle__col')];
  return cols.map((col) => {
    const title = col.querySelector('.live-battle__col-title');
    const rows = [...col.querySelectorAll('.live-battle__crow')];
    return {
      agg: !!col.querySelector('.live-battle__col-title--agg'),
      titleClass: title ? title.className : null,
      hvals: [...col.querySelectorAll('.live-battle__col-hval')].map((e) => e.getBoundingClientRect().right),
      rowCells: rows.map((r) => [...r.querySelectorAll('.replay-view__postbattle-cell-stat')].map((e) => e.getBoundingClientRect().right)),
      rowCount: rows.length,
      splitRows: rows.filter((r) => !!r.querySelector('.live-battle__crow-main--split')).length,
      metas: col.querySelectorAll('.live-ship-meta').length,
      sealSlots: col.querySelectorAll('.live-battle__crow-stampslot').length,
    };
  });
}
"""


def _prefs(**overrides):
    prefs = dict(BASE_PREFS)
    prefs.update(overrides)
    return prefs


def _open_live(browser, base_url, prefs):
    """Boot /live in a fresh profile with the density pref pinned (None = no
    stored prefs at all, i.e. the shipped defaults)."""
    context = browser.new_context(viewport=VIEWPORT)
    page = context.new_page()
    # The stored value is a JSON string: json.dumps once makes the blob, a
    # second time makes the JS string literal that carries it (an f-string
    # style double-dump, so the quotes/backslashes the browser evaluates are
    # exactly the blob).
    init = (
        "window.localStorage.setItem('wowsp-ui-locale', 'en-US');"
        "window.localStorage.setItem('wowsp-onboarding-completed', '1');"
    )
    if prefs is not None:
        init += "window.localStorage.setItem(%r, %s);" % (
            PREFS_KEY,
            json.dumps(json.dumps(prefs)),
        )
    page.add_init_script(init)
    page.goto("%s/live" % base_url, wait_until="domcontentloaded", timeout=120_000)
    return context, page


def _wait_roster(page):
    # The two-line team-aggregate header is the boot-complete marker of the
    # roster body (the idle guide carries none).
    expect(page.locator(".live-battle__col-title--agg").first).to_be_visible(timeout=90_000)
    expect(page.locator(".live-battle__crow").first).to_be_visible(timeout=60_000)
    # Let the batch stats settle: the alignment contract is about the cells,
    # and a settled panel keeps the measurements honest.
    page.wait_for_function(
        "() => document.querySelectorAll('.live-battle__col .hk-spinner-wrapper').length === 0",
        timeout=60_000,
    )
    page.wait_for_timeout(400)
    return page.evaluate(MEASURE_JS)


def _assert_aligned(metrics, label):
    failures: list[str] = []
    for side, col in enumerate(metrics):
        assert col["rowCount"] > 0, "%s side%d: roster rendered no rows" % (label, side)
        assert col["agg"], "%s side%d: header is not the aligned aggregate header: %r" % (
            label,
            side,
            col["titleClass"],
        )
        assert len(col["hvals"]) == CONFIGURED_COLUMNS, (
            "%s side%d: %d header columns for %d configured"
            % (label, side, len(col["hvals"]), CONFIGURED_COLUMNS)
        )
        for row_idx, cells in enumerate(col["rowCells"]):
            assert len(cells) == len(col["hvals"]), (
                "%s side%d row%d: %d stat cells vs %d header columns"
                % (label, side, row_idx, len(cells), len(col["hvals"]))
            )
            for col_idx, (cell, head) in enumerate(zip(cells, col["hvals"])):
                drift = abs(cell - head)
                if drift > TOLERANCE_PX:
                    failures.append(
                        "%s side%d row%d col%d: cell right %.2f vs header %.2f (drift %.2fpx)"
                        % (label, side, row_idx, col_idx, cell, head, drift)
                    )
    assert not failures, "roster columns drift off the header:\n  " + "\n  ".join(failures)


@pytest.mark.ui
def test_live_roster_ships_compact_rows_by_default(browser, vite_base_url):
    """A fresh profile (no stored stats prefs) opens /live on compact rows —
    the shipped default — and they align with the header."""
    context, page = _open_live(browser, vite_base_url, prefs=None)
    try:
        metrics = _wait_roster(page)
        assert all(col["splitRows"] == 0 for col in metrics), (
            "fresh profile should default to compact rows, got the full-mode split"
        )
        assert all(col["metas"] == 0 for col in metrics), (
            "compact rows must not render the full mode's ship-meta strip"
        )
        _assert_aligned(metrics, "default-compact")
    finally:
        context.close()


@pytest.mark.ui
@pytest.mark.parametrize("compact", [True, False], ids=["compact", "full"])
def test_live_roster_density_aligns_under_the_column_header(
    browser, vite_base_url, compact
):
    """Both densities put every stat cell on its header column; the full mode's
    only structural addition is the ship-meta strip in the middle of the row."""
    context, page = _open_live(browser, vite_base_url, prefs=_prefs(liveRosterCompact=compact))
    try:
        metrics = _wait_roster(page)
        label = "compact" if compact else "full"
        if compact:
            assert all(col["splitRows"] == 0 for col in metrics), (
                "compact rows must not carry the full-mode split"
            )
            assert all(col["metas"] == 0 for col in metrics), (
                "compact rows must not render the ship-meta strip"
            )
        else:
            assert all(col["splitRows"] == col["rowCount"] for col in metrics), (
                "full rows should all carry the middle meta split"
            )
            assert all(col["metas"] == col["rowCount"] for col in metrics), (
                "full rows should each render the ship-meta strip"
            )
        assert all(col["sealSlots"] == col["rowCount"] for col in metrics), (
            "the career-seal slot should be reserved on every row when seals show"
        )
        _assert_aligned(metrics, label)
    finally:
        context.close()


@pytest.mark.ui
@pytest.mark.parametrize("compact", [True, False], ids=["compact", "full"])
def test_live_roster_density_aligns_without_the_seal_slot(
    browser, vite_base_url, compact
):
    """Seals off: the header drops its right-edge reserve and every row drops
    its seal slot TOGETHER — the columns must still land on the header."""
    prefs = _prefs(liveRosterCompact=compact, sealsEnabled=False)
    context, page = _open_live(browser, vite_base_url, prefs=prefs)
    try:
        metrics = _wait_roster(page)
        label = "compact-no-seals" if compact else "full-no-seals"
        assert all(col["sealSlots"] == 0 for col in metrics), (
            "seals off: no roster row should reserve the seal slot"
        )
        assert all("live-battle__col-title--pad-seal" not in (col["titleClass"] or "") for col in metrics), (
            "seals off: the header must drop its seal-slot right-edge reserve"
        )
        _assert_aligned(metrics, label)
    finally:
        context.close()
