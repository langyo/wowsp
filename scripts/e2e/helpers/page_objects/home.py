"""Home page object for WoWSP e2e tests."""
from __future__ import annotations


class HomePage:
    """Wraps the `/` (home) view. Selectors target the home__* classes from
    `packages/webui/src/views/HomeView.tsx`."""

    def __init__(self, page) -> None:
        self.page = page

    @property
    def title(self):
        return self.page.locator(".home__title")

    @property
    def replay_link(self):
        return self.page.locator(".home__modes .s-btn", has_text="Replay review")

    @property
    def overlay_link(self):
        return self.page.locator(".home__modes .s-btn", has_text="In-game overlay")

    def goto(self, base_url: str) -> None:
        self.page.goto(base_url)

    def go_replay(self) -> None:
        self.replay_link.click()
