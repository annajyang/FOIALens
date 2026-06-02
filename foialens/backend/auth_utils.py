import hashlib
import hmac
import os
import secrets
import time
import uuid
from typing import Annotated, Optional

import jwt
from fastapi import Depends, Header, HTTPException

_SECRET = os.environ.get("JWT_SECRET", "foialens-dev-secret-change-in-production")
_ALGORITHM = "HS256"
_EXPIRY_DAYS = 30


def create_jwt(email: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"email": email, "iat": now, "exp": now + _EXPIRY_DAYS * 86400},
        _SECRET,
        algorithm=_ALGORITHM,
    )


def decode_jwt(token: str) -> str | None:
    try:
        payload = jwt.decode(token, _SECRET, algorithms=[_ALGORITHM])
        return payload.get("email") or None
    except jwt.PyJWTError:
        return None


def generate_otp() -> tuple[str, str]:
    """Returns (plaintext_code, sha256_hex_hash)."""
    code = str(secrets.randbelow(10**6)).zfill(6)
    return code, _hash_otp(code)


def verify_otp(plaintext: str, stored_hash: str) -> bool:
    return hmac.compare_digest(_hash_otp(plaintext), stored_hash)


def _hash_otp(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _get_session(
    x_guest_token: Optional[str] = Header(None),
    x_auth_token: Optional[str] = Header(None),
) -> tuple[str | None, str | None]:
    """Resolve (guest_token, email). Email is only trusted when backed by a valid JWT."""
    if x_auth_token:
        email = decode_jwt(x_auth_token)
        if email:
            return None, email
    return x_guest_token or None, None


Session = Annotated[tuple[str | None, str | None], Depends(_get_session)]


def check_workspace_access(ws, token: str | None, email: str | None) -> None:
    """Raise 403 if the session cannot access the given workspace (or workspace-joined) record."""
    if ws["owner_email"] and email and ws["owner_email"] == email:
        return
    if ws["guest_token"] and token:
        try:
            if ws["guest_token"] == uuid.UUID(token):
                return
        except (ValueError, AttributeError):
            pass
    if not ws["guest_token"] and not ws["owner_email"]:
        return  # legacy workspace without access control
    raise HTTPException(status_code=403, detail="Access denied.")
