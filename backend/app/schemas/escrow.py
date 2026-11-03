"""Encryption Key Escrow panelinin HTTP sozlesmesi.

Bu moduldeki hicbir model ANAHTARI tasimaz; tek istisna `EscrowRevealResponse`
ve o da yalnizca tek kullanimlik, kisa omurlu bir yanitta kullanilir.
"""

from typing import Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class EscrowCopyAttestation(BaseModel):
    """Operator beyani. Makine dogrulamasi DEGILDIR: sistem kagidi goremez."""

    anchor8: str
    attested_at: str
    attested_by: str
    note: str = ""


class EscrowCopies(BaseModel):
    A: Optional[EscrowCopyAttestation] = None
    B: Optional[EscrowCopyAttestation] = None


class EscrowRevealMark(BaseModel):
    at: str
    by: str


class EscrowStatusResponse(BaseModel):
    state: Literal["PRESENT", "MISSING", "INVALID", "UNREACHABLE"]
    path: str
    key_len: Optional[int] = None
    anchor8: Optional[str] = None
    mode: Optional[str] = None
    mtime: Optional[str] = None
    file_sha256_12: Optional[str] = None
    reason: Optional[str] = None
    panel_enabled: bool = False
    copies: EscrowCopies = Field(default_factory=EscrowCopies)
    last_reveal: Optional[EscrowRevealMark] = None
    reveal_ttl_seconds: int = 60
    stepup_ttl_seconds: int = 300


class EscrowStepUpStartResponse(BaseModel):
    authorization_url: str
    state: str
    expires_in: int


class EscrowRevealRequest(BaseModel):
    # Acik onay zorunlu: `confirm` olmadan anahtar donmez. Varsayilan False.
    confirm: bool = False
    reason: Optional[str] = Field(default=None, max_length=200)


class EscrowRevealResponse(BaseModel):
    key: str
    anchor8: str
    key_len: int
    expires_in: int


class EscrowAttestRequest(BaseModel):
    # Alan adi `copy_name`: `copy` BaseModel'in kendi metodunu golgeliyor ve
    # pydantic uyariyor. Disariya donuk ad (`copy`) alias ile korunur.
    model_config = ConfigDict(populate_by_name=True)

    copy_name: Literal["A", "B"] = Field(alias="copy")
    anchor8: str = Field(min_length=8, max_length=8)
    note: str = Field(default="", max_length=200)


class EscrowAttestResponse(BaseModel):
    copies: EscrowCopies
    updated_at: Optional[str] = None


class EscrowErrorResponse(BaseModel):
    detail: str
    reason: Optional[str] = None
    extra: Optional[Dict[str, str]] = None
