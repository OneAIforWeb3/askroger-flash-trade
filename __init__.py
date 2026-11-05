"""Flash (Definitive) trading proxy.

The webapp never sees the Flash API key: it calls these routes with its normal
login JWT + api-key, the blueprint adds `x-definitive-api-key`, pins the
integrator fee, validates the shape, and forwards to https://flash.definitive.fi.
Signing happens in the user's wallet; Flash is non-custodial and pays execution gas.

Built during ETHGlobal Mumbai (Nov 2026). Everything trading-related lives in this
package so it can be published on its own.
"""
from flask import Blueprint

trade_bp = Blueprint("trade", __name__)

from app.api.trade import routes  # noqa: E402,F401  (registers routes on trade_bp)
