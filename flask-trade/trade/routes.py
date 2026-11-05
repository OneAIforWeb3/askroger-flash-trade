"""/trade/* routes. Money paths use require_login(always_enforce=True): a trade must
never run through the shadow fall-through. The public token summary has no auth."""
from decimal import Decimal, InvalidOperation

from flask import current_app, g, jsonify, request

from app.api.custom_decorators import require_login
from app.api.trade import trade_bp
from app.api.trade.constants import (
    ALLOWED_ORDER_TYPES, ALLOWED_SIDES, CHAIN_ALIASES, FLASH_CHAINS, INSERT_ORDER_QUERY,
    MY_ORDERS_QUERY, ORDER_PASSTHROUGH, ORDER_STATUSES_TERMINAL, QUOTE_ONLY_FIELDS, QUOTE_PASSTHROUGH,
    TOKEN_ORDERS_COUNT_QUERY, TOKEN_ORDERS_SUMMARY_QUERY, UPDATE_ORDER_STATUS_FROM_LIST_QUERY,
    UPDATE_ORDER_STATUS_QUERY,
)
from app.api.trade.flash_client import flash_request, integrator_fee_bps, is_configured


@trade_bp.after_request
def _never_cache(resp):
    """api.x-alpha.ai is fronted by CloudFront, which caches GETs for ~2 minutes
    regardless of auth headers. An order status served stale left the drawer on
    'accepted' after the fill had landed. Nothing under /trade is cacheable."""
    resp.headers["Cache-Control"] = "no-store, private, max-age=0"
    return resp


def normalize_chain(chain):
    chain = str(chain or "").strip().lower()
    return CHAIN_ALIASES.get(chain, chain)


def _bad(message, code="INVALID_REQUEST"):
    return jsonify({"error": {"code": code, "message": message, "details": None}}), 400


def _respond(body, status, headers):
    resp = jsonify(body)
    resp.status_code = status
    for k, v in headers.items():
        resp.headers[k] = v
    return resp


def _validate_order_fields(body):
    """Shared checks for quote and order. Returns (payload, error_response)."""
    payload = {k: body[k] for k in QUOTE_PASSTHROUGH if k in body and body[k] is not None}
    for key in ("targetChain", "contraChain"):
        payload[key] = normalize_chain(payload.get(key))
        if payload[key] not in FLASH_CHAINS:
            return None, _bad(f"{key} '{payload[key]}' is not supported by Flash", "UNSUPPORTED_CHAIN")
    if payload["targetChain"] != payload["contraChain"]:
        return None, _bad("cross-chain orders are not enabled", "UNSUPPORTED_ORDER")
    if payload.get("orderType") not in ALLOWED_ORDER_TYPES:
        return None, _bad(f"orderType must be one of {sorted(ALLOWED_ORDER_TYPES)}", "UNSUPPORTED_ORDER")
    if payload.get("side") not in ALLOWED_SIDES:
        return None, _bad("side must be buy or sell")
    for key in ("targetAsset", "contraAsset", "funderAddress"):
        if not isinstance(payload.get(key), str) or not payload[key].strip():
            return None, _bad(f"{key} is required")
    try:
        qty = Decimal(str(payload.get("qty")))
    except (InvalidOperation, TypeError):
        return None, _bad("qty must be a decimal string")
    if qty <= 0:
        return None, _bad("qty must be positive")
    payload["qty"] = str(payload["qty"])
    if payload["orderType"] == "limit" and not (payload.get("limitNotionalPrice") or payload.get("limitCrossPrice")):
        return None, _bad("limit orders need limitNotionalPrice or limitCrossPrice")
    fee = integrator_fee_bps()
    if fee != "0":
        payload["flashIntegratorFeeBps"] = fee
    return payload, None


@trade_bp.route("/status", methods=["GET"])
def trade_status():
    """Lets the webapp hide the button when the server has no key."""
    return jsonify({"enabled": is_configured(), "integratorFeeBps": integrator_fee_bps(),
                    "orderTypes": sorted(ALLOWED_ORDER_TYPES), "chains": sorted(FLASH_CHAINS)})


@trade_bp.route("/quote", methods=["POST"])
@require_login(always_enforce=True)
def quote():
    body = request.get_json(silent=True) or {}
    payload, err = _validate_order_fields(body)
    if err:
        return err
    result, status, headers = flash_request("POST", "/quote", json_body=payload)
    if status < 400 and isinstance(result, dict):
        result["integratorFeeBps"] = payload.get("flashIntegratorFeeBps", "0")
        result["normalized"] = {k: payload[k] for k in ("targetChain", "contraChain", "orderType", "side", "qty")}
    return _respond(result, status, headers)


@trade_bp.route("/order", methods=["POST"])
@require_login(always_enforce=True)
def place_order():
    body = request.get_json(silent=True) or {}
    payload, err = _validate_order_fields(body)
    if err:
        return err
    for key in QUOTE_ONLY_FIELDS:
        payload.pop(key, None)
    for key in ORDER_PASSTHROUGH:
        if key in body and body[key] is not None and key not in payload:
            payload[key] = body[key]
    if not payload.get("userSignature") or not payload.get("quoteId"):
        return _bad("quoteId and userSignature are required")
    result, status, headers = flash_request("POST", "/order", json_body=payload)
    if status in (200, 201) and isinstance(result, dict) and result.get("orderId"):
        meta = body.get("meta") or {}
        try:
            current_app.config["WRITE_DB"].execute_query(
                query=INSERT_ORDER_QUERY,
                values=(
                    result["orderId"], str(g.tg_id), payload["funderAddress"], payload["targetChain"],
                    payload["targetAsset"], str(meta.get("pair_id") or "")[:128] or None,
                    str(meta.get("token_symbol") or "")[:64] or None, payload["orderType"], payload["side"],
                    payload["qty"], payload["contraAsset"], _decimal_or_none(meta.get("quote_notional_usd")),
                    int(payload.get("flashIntegratorFeeBps", "0")), _decimal_or_none(payload.get("limitNotionalPrice")),
                ),
            )
        except Exception as exc:  # the order is live on Flash; never fail the response over our bookkeeping
            current_app.logger.error(f"flash_orders insert failed for {result['orderId']}: {exc}")
    return _respond(result, status, headers)


def _decimal_or_none(value):
    if value in (None, ""):
        return None
    try:
        return str(Decimal(str(value)))
    except (InvalidOperation, TypeError):
        return None


@trade_bp.route("/orders", methods=["GET"])
@require_login(always_enforce=True)
def list_orders():
    funder = request.args.get("funderAddress", "").strip()
    if not funder:
        return _bad("funderAddress is required")
    params = {"funderAddress": funder}
    for key in ("statuses", "pageSize", "pageToken"):
        if request.args.get(key):
            params[key] = request.args[key]
    result, status, headers = flash_request("GET", "/orders", params=params)
    if status == 200 and isinstance(result, dict):
        _sync_rows_from_list(result.get("orders") or [])
    return _respond(result, status, headers)


def _sync_rows_from_list(orders):
    """A resting order that fills hours later would otherwise stay 'pending' in our
    table until that single order is fetched again. The list already carries the
    current status of every order for the wallet, so fold it in here at no extra
    Flash call. Best effort: a DB hiccup never fails the user's list."""
    db = current_app.config["WRITE_DB"]
    for order in orders:
        order_id, new_status = order.get("orderId"), order.get("status")
        if not order_id or not new_status:
            continue
        filled = order.get("filled") or {}
        notional = None
        if new_status in ORDER_STATUSES_TERMINAL or filled.get("contraAmount"):
            notional = _filled_notional(order, filled)
        try:
            db.execute_query(
                query=UPDATE_ORDER_STATUS_FROM_LIST_QUERY,
                values=(new_status, notional, order_id, str(g.tg_id), new_status))
        except Exception as exc:
            current_app.logger.error(f"flash_orders list sync failed for {order_id}: {exc}")


def _filled_notional(order, filled):
    """USD value of the filled part. For a USDC-contra buy the contra amount is the
    notional itself; otherwise fall back to average notional price x target amount."""
    try:
        if order.get("side") == "buy" and filled.get("contraAmount"):
            return str(Decimal(str(filled["contraAmount"])))
        if filled.get("averageNotionalPrice") and filled.get("targetAmount"):
            return str(Decimal(str(filled["averageNotionalPrice"])) * Decimal(str(filled["targetAmount"])))
    except InvalidOperation:
        pass
    return None


MY_ORDERS_COLUMNS = (
    "orderId", "chain", "tokenId", "pairId", "tokenSymbol", "orderType", "side", "qty",
    "contraAsset", "quoteNotionalUsd", "filledNotionalUsd", "integratorFeeBps",
    "limitNotionalPrice", "status", "fillTx", "placedAt", "updatedAt", "funderAddress",
)


@trade_bp.route("/mine", methods=["GET"])
@require_login(always_enforce=True)
def my_orders():
    """Every Flash order this login has placed through askRoger, across tokens and
    wallets. Open orders are refreshed from Flash first (one list call per funder
    wallet that still has a non-terminal row, capped so a hostile account cannot
    turn this into a Flash rate-limit burner)."""
    db = current_app.config["READ_DB"]
    rows = db.fetchall(query=MY_ORDERS_QUERY, values=(str(g.tg_id),))
    open_funders = []
    for r in rows:
        if r[13] not in ORDER_STATUSES_TERMINAL and r[17] and r[17] not in open_funders:
            open_funders.append(r[17])
    for funder in open_funders[:3]:
        result, status, _ = flash_request("GET", "/orders", params={"funderAddress": funder, "pageSize": 50})
        if status == 200 and isinstance(result, dict):
            _sync_rows_from_list(result.get("orders") or [])
    if open_funders:
        rows = db.fetchall(query=MY_ORDERS_QUERY, values=(str(g.tg_id),))
    orders = []
    for r in rows:
        item = dict(zip(MY_ORDERS_COLUMNS, r))
        for k in ("qty", "quoteNotionalUsd", "filledNotionalUsd", "limitNotionalPrice"):
            item[k] = None if item[k] is None else str(item[k])
        for k in ("placedAt", "updatedAt"):
            item[k] = item[k].isoformat() if hasattr(item[k], "isoformat") else item[k]
        orders.append(item)
    return jsonify({"orders": orders})


@trade_bp.route("/orders/<order_id>", methods=["GET"])
@require_login(always_enforce=True)
def get_order(order_id):
    funder = request.args.get("funderAddress", "").strip()
    if not funder:
        return _bad("funderAddress is required")
    result, status, headers = flash_request("GET", f"/orders/{order_id}", params={"funderAddress": funder})
    if status == 200 and isinstance(result, dict):
        _sync_order_row(order_id, result)
    return _respond(result, status, headers)


def _sync_order_row(order_id, result):
    order = result.get("order") or {}
    new_status = order.get("status")
    if not new_status:
        return
    fills = result.get("fills") or []
    fill_tx = next((f.get("transactionId") for f in fills if f.get("transactionId")), None)
    filled_notional = None
    if new_status in ORDER_STATUSES_TERMINAL or fills:
        try:
            filled_notional = str(sum(Decimal(str(f.get("notional") or 0)) for f in fills)) if fills else None
        except InvalidOperation:
            filled_notional = None
    try:
        current_app.config["WRITE_DB"].execute_query(
            query=UPDATE_ORDER_STATUS_QUERY,
            values=(new_status, fill_tx, filled_notional, order_id, str(g.tg_id)))
    except Exception as exc:
        current_app.logger.error(f"flash_orders status sync failed for {order_id}: {exc}")


@trade_bp.route("/orders/<order_id>/cancel", methods=["POST"])
@require_login(always_enforce=True)
def cancel_order(order_id):
    body = request.get_json(silent=True) or {}
    if not body.get("cancelMessage") or not body.get("userSignature"):
        return _bad("cancelMessage and userSignature are required")
    payload = {"cancelMessage": body["cancelMessage"], "userSignature": body["userSignature"]}
    result, status, headers = flash_request("POST", f"/orders/{order_id}/cancel", json_body=payload)
    if status == 200 and isinstance(result, dict) and result.get("ok"):
        try:
            current_app.config["WRITE_DB"].execute_query(
                query=UPDATE_ORDER_STATUS_QUERY,
                values=("ORDER_STATUS_CANCELLED", None, None, order_id, str(g.tg_id)))
        except Exception as exc:
            current_app.logger.error(f"flash_orders cancel sync failed for {order_id}: {exc}")
    return _respond(result, status, headers)


@trade_bp.route("/token/<chain>/<token_id>/orders", methods=["GET"])
def token_orders_summary(chain, token_id):
    """Public social line: how many askRoger users traded this token through Flash.
    Funder addresses are truncated and no user ids leave the server."""
    chain = normalize_chain(chain)
    if chain not in FLASH_CHAINS:
        return jsonify({"count": 0, "traders": 0, "recent": []})
    db = current_app.config["READ_DB"]
    counts = db.fetchall(query=TOKEN_ORDERS_COUNT_QUERY, values=(chain, token_id))
    rows = db.fetchall(query=TOKEN_ORDERS_SUMMARY_QUERY, values=(chain, token_id))
    count, traders = (counts[0] if counts else (0, 0))
    recent = [
        {
            "orderType": r[0], "side": r[1],
            "funder": f"{r[2][:6]}…{r[2][-4:]}" if r[2] and len(r[2]) > 12 else r[2],
            "status": r[3], "placedAt": r[4].isoformat() if hasattr(r[4], "isoformat") else str(r[4]),
        }
        for r in rows
    ]
    return jsonify({"count": int(count or 0), "traders": int(traders or 0), "recent": recent})
