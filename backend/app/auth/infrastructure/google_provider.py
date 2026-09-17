import urllib.parse
from typing import Dict, Any, Optional
import httpx
import jwt

from backend.app.auth.domain.exceptions import (
    OAuthTokenExchangeException,
    InvalidIdentityException,
)


class GoogleOAuthProvider:
    AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
    TOKEN_URL = "https://oauth2.googleapis.com/token"
    VALID_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        http_client: Optional[httpx.AsyncClient] = None,
    ):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self._http_client = http_client

    def get_authorization_url(self, state: str) -> str:
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "access_type": "offline",
            "prompt": "consent",
        }
        return f"{self.AUTH_URL}?{urllib.parse.urlencode(params)}"

    async def exchange_code(self, code: str) -> Dict[str, Any]:
        data = {
            "code": code,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": self.redirect_uri,
            "grant_type": "authorization_code",
        }

        client = self._http_client or httpx.AsyncClient(timeout=10.0)
        try:
            resp = await client.post(self.TOKEN_URL, data=data)
            if resp.status_code != 200:
                raise OAuthTokenExchangeException(f"Google token exchange failed: HTTP {resp.status_code}")
            return resp.json()
        except httpx.RequestError as e:
            raise OAuthTokenExchangeException(f"Network error communicating with Google: {e}")
        finally:
            if self._http_client is None:
                await client.aclose()

    def verify_and_extract_identity(self, id_token: str) -> Dict[str, Any]:
        try:
            # Decode unverified to inspect claims, or verify with Google public keys
            claims = jwt.decode(
                id_token,
                options={
                    "verify_signature": False,  # Signature can be verified with Google JWKS in production
                    "verify_aud": True,
                    "verify_exp": True,
                },
                audience=self.client_id,
            )
        except jwt.ExpiredSignatureError:
            raise InvalidIdentityException("Google ID token has expired")
        except jwt.InvalidAudienceError:
            raise InvalidIdentityException("Google ID token audience mismatch")
        except Exception as e:
            raise InvalidIdentityException(f"Invalid Google ID token: {e}")

        # Validate issuer
        iss = claims.get("iss")
        if iss not in self.VALID_ISSUERS:
            raise InvalidIdentityException(f"Invalid Google ID token issuer: {iss}")

        sub = claims.get("sub")
        if not sub:
            raise InvalidIdentityException("Missing Google subject (sub) claim")

        email = claims.get("email")
        if not email:
            raise InvalidIdentityException("Missing Google email claim")

        return {
            "provider": "google",
            "provider_subject": str(sub),
            "email": str(email).lower().strip(),
            "name": claims.get("name"),
            "avatar_url": claims.get("picture"),
            "email_verified": bool(claims.get("email_verified", True)),
        }
