"""
Abstract Base Provider Adapter for B2B Lead Discovery.
Defines standard interface for all discovery providers (Directories, Maps, OSM, Web).
"""
from abc import ABC, abstractmethod
from typing import List
import httpx
from backend.app.schemas.intelligence import (
    ProviderQuery,
    RawBusinessCandidate
)


class BaseProviderAdapter(ABC):
    """
    Abstract Provider Adapter:
    Responsible for executing a provider-specific query and returning normalized RawBusinessCandidate records with full provenance.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        pass

    @abstractmethod
    async def execute_query(
        self,
        client: httpx.AsyncClient,
        query: ProviderQuery,
        max_pages: int = 3
    ) -> List[RawBusinessCandidate]:
        """
        Executes a single ProviderQuery and returns raw candidate records.
        """
        pass
