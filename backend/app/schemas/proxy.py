from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional


class ProxyConfigSchema(BaseModel):
    enabled: bool = False
    proxies: List[str] = Field(default_factory=list, description="Proxy listesi (http://ip:port veya http://user:pass@ip:port)")
    rotation_strategy: str = Field(default="ROUND_ROBIN", description="ROUND_ROBIN | RANDOM")
    timeout_seconds: float = Field(default=8.0, ge=1.0, le=60.0)


class ProxyPoolStatusResponse(BaseModel):
    enabled: bool
    total_proxies: int
    active_proxies: int
    rotation_strategy: str
    proxies: List[str]
    timeout_seconds: float


class ProxyTestRequest(BaseModel):
    proxy_url: str


class ProxyTestResponse(BaseModel):
    success: bool
    proxy_url: str
    latency_ms: Optional[float] = None
    exit_ip: Optional[str] = None
    error: Optional[str] = None
