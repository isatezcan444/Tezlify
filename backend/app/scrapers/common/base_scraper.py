from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional, Callable


class BaseScraper(ABC):
    """
    Abstract Base Class for B2B Scrapers.
    Accepts structured location parameters (city + districts) — not opaque strings.
    """

    def __init__(self, user_agent: Optional[str] = None):
        self.user_agent = user_agent or (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        )

    @abstractmethod
    async def scrape(
        self,
        keyword: str,
        city: str,
        districts: List[str],
        max_results: int = 50,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    ) -> List[Dict[str, Any]]:
        """
        Executes search for `keyword` in `city` / `districts` up to `max_results`.
        Districts list is the authoritative scope — scraper must NOT expand beyond it.
        """
        pass
