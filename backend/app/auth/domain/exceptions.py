"""Auth domain exceptions."""

class AuthException(Exception):
    """Base exception for all auth errors."""
    pass


class InvalidOAuthStateException(AuthException):
    """OAuth state is invalid, expired, or already consumed."""
    pass


class OAuthTokenExchangeException(AuthException):
    """Failed to exchange authorization code with OAuth provider."""
    pass


class InvalidIdentityException(AuthException):
    """ID token or user identity claims failed verification."""
    pass


class SessionNotFoundException(AuthException):
    """Session was not found or is expired/revoked."""
    pass


class UserInactiveException(AuthException):
    """User account is deactivated."""
    pass
