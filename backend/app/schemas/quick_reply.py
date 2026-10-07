from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, field_validator


class QuickReplyVariable(BaseModel):
    key: str
    label: str
    default_from: Optional[str] = None
    default_value: Optional[str] = None


class QuickReplyCreate(BaseModel):
    shortcut: str
    title: str
    content: str
    category: Optional[str] = "Genel"
    variables: Optional[List[Dict[str, Any]]] = None

    @field_validator("shortcut")
    @classmethod
    def validate_shortcut(cls, v: str) -> str:
        s = v.strip().lower()
        if not s or s == "/":
            raise ValueError("Kısayol boş olamaz")
        if not s.startswith("/"):
            s = f"/{s}"
        if len(s) > 50:
            raise ValueError("Kısayol en fazla 50 karakter olabilir")
        return s

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        t = v.strip()
        if not t:
            raise ValueError("Başlık boş olamaz")
        if len(t) > 100:
            raise ValueError("Başlık en fazla 100 karakter olabilir")
        return t

    @field_validator("content")
    @classmethod
    def validate_content(cls, v: str) -> str:
        c = v.strip()
        if not c:
            raise ValueError("Mesaj içeriği boş olamaz")
        return c


class QuickReplyUpdate(BaseModel):
    shortcut: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    category: Optional[str] = None
    variables: Optional[List[Dict[str, Any]]] = None

    @field_validator("shortcut")
    @classmethod
    def validate_shortcut(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = v.strip().lower()
        if not s or s == "/":
            raise ValueError("Kısayol boş olamaz")
        if not s.startswith("/"):
            s = f"/{s}"
        if len(s) > 50:
            raise ValueError("Kısayol en fazla 50 karakter olabilir")
        return s

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        t = v.strip()
        if not t:
            raise ValueError("Başlık boş olamaz")
        if len(t) > 100:
            raise ValueError("Başlık en fazla 100 karakter olabilir")
        return t

    @field_validator("content")
    @classmethod
    def validate_content(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        c = v.strip()
        if not c:
            raise ValueError("Mesaj içeriği boş olamaz")
        return c


class QuickReplyResponse(BaseModel):
    id: int
    user_id: Optional[str] = None
    shortcut: str
    title: str
    content: str
    category: Optional[str] = "Genel"
    variables: Optional[List[Dict[str, Any]]] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class QuickReplyListResponse(BaseModel):
    items: List[QuickReplyResponse]
    total: int


class QuickReplyDeleteResponse(BaseModel):
    success: bool
    id: int
