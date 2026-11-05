"""Thin requests wrapper around the Flash REST API.

One place holds the key and the base URL. Flash's own status code and
`{"error": {code, message, details}}` body pass through unchanged so the webapp
can show Flash's message; transport failures become a 502 with the same shape.
"""
import os

import requests
from flask import current_app

from app.api.trade.constants import FLASH_BASE_URL

TIMEOUT_SECONDS = 15
RATE_LIMIT_HEADERS = ("RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset")


def api_key():
    return os.getenv("FLASH_API_KEY", "")


def integrator_fee_bps():
    """Fee in basis points as the string Flash expects. '0' or unset disables it.
    Clamped to Flash's maximum of 1000 (10%)."""
    raw = os.getenv("FLASH_INTEGRATOR_FEE_BPS", "0").strip()
    try:
        bps = max(0, min(int(raw), 1000))
    except ValueError:
        bps = 0
    return str(bps)


def is_configured():
    return bool(api_key())


def error_response(code, message, status):
    return {"error": {"code": code, "message": message, "details": None}}, status, {}


def flash_request(method, path, json_body=None, params=None):
    """Returns (body, status, passthrough_headers)."""
    if not is_configured():
        return error_response("TRADING_NOT_CONFIGURED", "Flash trading is not enabled on this server", 503)
    url = f"{FLASH_BASE_URL}{path}"
    try:
        resp = requests.request(
            method, url, json=json_body, params=params, timeout=TIMEOUT_SECONDS,
            headers={"x-definitive-api-key": api_key(), "content-type": "application/json"},
        )
    except requests.RequestException as exc:
        current_app.logger.error(f"flash {method} {path} transport error: {exc}")
        return error_response("FLASH_UNREACHABLE", "Flash API did not respond", 502)
    headers = {h: resp.headers[h] for h in RATE_LIMIT_HEADERS if h in resp.headers}
    try:
        body = resp.json() if resp.content else {}
    except ValueError:
        body = {"error": {"code": "BAD_UPSTREAM_JSON", "message": resp.text[:200], "details": None}}
    if resp.status_code >= 400:
        code = (body.get("error") or {}).get("code") if isinstance(body, dict) else None
        current_app.logger.warning(f"flash {method} {path} -> {resp.status_code} {code}")
    return body, resp.status_code, headers
