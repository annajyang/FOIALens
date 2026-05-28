import asyncio
import os
import smtplib
import uuid
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from auth_utils import create_jwt, generate_otp, verify_otp
from db.client import pool

router = APIRouter()


def _send_gmail(gmail_user: str, gmail_password: str, to: str, code: str, html: str) -> None:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Your FOIALens sign-in code"
    msg["From"] = f"FOIALens <{gmail_user}>"
    msg["To"] = to
    msg.attach(MIMEText(html, "html"))
    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(gmail_user, gmail_password)
        server.sendmail(gmail_user, to, msg.as_string())


class RequestBody(BaseModel):
    email: str


class VerifyBody(BaseModel):
    email: str
    code: str


@router.post("/auth/request")
async def request_code(body: RequestBody):
    email = body.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email required.")

    code, code_hash = generate_otp()
    token_id = uuid.uuid4()

    await pool().execute(
        """
        INSERT INTO auth_tokens (id, email, code_hash)
        VALUES ($1, $2, $3)
        """,
        token_id, email, code_hash,
    )

    gmail_user = os.environ.get("GMAIL_USER")
    gmail_password = os.environ.get("GMAIL_APP_PASSWORD")
    if not gmail_user or not gmail_password:
        # Dev fallback: print code to server stdout
        print(f"[auth] DEV — OTP for {email}: {code}", flush=True)
    else:
        html = (
            "<p style='font-family:sans-serif'>Your FOIALens sign-in code is:</p>"
            f"<h1 style='letter-spacing:0.15em;font-family:monospace;font-size:40px'>{code}</h1>"
            "<p style='font-family:sans-serif;color:#666'>Expires in 10 minutes · one-time use</p>"
        )
        try:
            await asyncio.to_thread(_send_gmail, gmail_user, gmail_password, email, code, html)
        except Exception as exc:
            print(f"[auth] Gmail error: {exc}", flush=True)
            raise HTTPException(status_code=502, detail="Failed to send verification email.")

    return {"sent": True}


@router.post("/auth/verify")
async def verify_code(
    body: VerifyBody,
    x_guest_token: Optional[str] = Header(None),
):
    email = body.email.strip().lower()
    code = body.code.strip()

    row = await pool().fetchrow(
        """
        SELECT id, code_hash
        FROM auth_tokens
        WHERE email = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
        """,
        email,
    )

    if not row or not verify_otp(code, row["code_hash"]):
        raise HTTPException(status_code=401, detail="Invalid or expired code.")

    await pool().execute(
        "UPDATE auth_tokens SET used_at = NOW() WHERE id = $1",
        row["id"],
    )

    # Claim any anonymous workspaces from this browser session.
    if x_guest_token:
        try:
            await pool().execute(
                "UPDATE workspaces "
                "SET owner_email = $1, expires_at = NULL, guest_token = NULL "
                "WHERE guest_token = $2::uuid AND owner_email IS NULL",
                email, x_guest_token,
            )
        except Exception as e:
            print(f"[auth] workspace claim failed: {e}", flush=True)

    return {"token": create_jwt(email), "email": email}
