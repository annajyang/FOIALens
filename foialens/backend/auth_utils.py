import hashlib
import hmac
import os
import secrets
import time

import jwt

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
