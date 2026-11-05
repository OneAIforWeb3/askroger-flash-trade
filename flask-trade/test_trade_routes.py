"""Hermetic tests for app/api/trade (no AWS, no DB, no network): the auth decorator
is stubbed to a fixed user, the DB handles record calls, and flash_request is faked.

    python3 -m pytest test_trade_routes.py -v
"""
import os
import sys
import types

import pytest
from flask import Flask, g

HERE = os.path.dirname(os.path.abspath(__file__))

app_pkg = types.ModuleType("app")
app_pkg.__path__ = [HERE]
api_pkg = types.ModuleType("app.api")
api_pkg.__path__ = [HERE]
decorators_stub = types.ModuleType("app.api.custom_decorators")


def _require_login(f=None, *, always_enforce=False):
    def decorator(func):
        def wrapped(*a, **kw):
            g.tg_id = "4242"
            return func(*a, **kw)
        wrapped.__name__ = func.__name__
        return wrapped
    return decorator(f) if f is not None else decorator


decorators_stub.require_login = _require_login
sys.modules["app"] = app_pkg
sys.modules["app.api"] = api_pkg
sys.modules["app.api.custom_decorators"] = decorators_stub

from app.api.trade import trade_bp  # noqa: E402
from app.api.trade import flash_client, routes  # noqa: E402


class FakeDB:
    def __init__(self):
        self.executed = []
        self.rows = {}

    def execute_query(self, query, values=None, retry_count=3):
        self.executed.append((query.strip().split()[0], values))

    def fetchall(self, query, values=None):
        key = "COUNT" if "COUNT(*)" in query else ("MINE" if "tg_id = %s" in query else "ROWS")
        return self.rows.get(key, [])


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("FLASH_API_KEY", "test-key")
    monkeypatch.setenv("FLASH_INTEGRATOR_FEE_BPS", "50")
    app = Flask(__name__)
    app.config["WRITE_DB"] = FakeDB()
    app.config["READ_DB"] = FakeDB()
    app.register_blueprint(trade_bp, url_prefix="/trade")
    calls = []

    def fake_flash(method, path, json_body=None, params=None):
        calls.append((method, path, json_body, params))
        if path == "/quote":
            return {"quoteId": "q1", "evm": {"orderTypedData": "{}"}}, 200, {"RateLimit-Remaining": "4"}
        if path == "/order":
            return {"orderId": "o1", "attachedBracket": None}, 201, {}
        if path.startswith("/orders/") and path.endswith("/cancel"):
            return {"ok": True}, 200, {}
        if path.startswith("/orders/"):
            return {"order": {"status": "ORDER_STATUS_FILLED"},
                    "fills": [{"transactionId": "0xabc", "notional": "2.01"}]}, 200, {}
        if path == "/orders":
            return {"orders": [
                {"orderId": "o-old", "status": "ORDER_STATUS_FILLED", "side": "buy",
                 "filled": {"contraAmount": "5", "targetAmount": "1213.6", "averageNotionalPrice": "0.0041"}},
                {"orderId": "o-rest", "status": "ORDER_STATUS_ACCEPTED", "side": "buy", "filled": {}},
                {"orderId": "o-sell", "status": "ORDER_STATUS_FILLED", "side": "sell",
                 "filled": {"targetAmount": "100", "averageNotionalPrice": "0.02"}},
                {"orderId": None, "status": "ORDER_STATUS_FILLED"},
            ], "nextPageToken": None}, 200, {}
        raise AssertionError(path)

    monkeypatch.setattr(routes, "flash_request", fake_flash)
    app.flash_calls = calls
    return app.test_client(), app


QUOTE = {
    "targetChain": "binance", "contraChain": "binance",
    "targetAsset": "0xtoken", "contraAsset": "0xusdc", "side": "buy", "qty": "2",
    "orderType": "limit", "limitNotionalPrice": "0.5", "funderAddress": "0xfunder",
    "flashIntegratorFeeBps": "999",  # client-supplied fee must be ignored
}


def test_trade_responses_are_never_cacheable(client):
    c, _ = client
    for resp in (c.get("/trade/status"), c.get("/trade/orders?funderAddress=0xf"),
                 c.get("/trade/token/base/0x/orders")):
        assert resp.headers["Cache-Control"] == "no-store, private, max-age=0"


def test_status_reports_config(client):
    c, _ = client
    body = c.get("/trade/status").get_json()
    assert body["enabled"] is True and body["integratorFeeBps"] == "50"
    assert body["orderTypes"] == ["limit", "market"]


def test_quote_normalizes_chain_and_pins_fee(client):
    c, app = client
    resp = c.post("/trade/quote", json=QUOTE)
    assert resp.status_code == 200
    assert resp.headers["RateLimit-Remaining"] == "4"
    _, path, sent, _ = app.flash_calls[0]
    assert path == "/quote"
    assert sent["targetChain"] == "bsc" and sent["contraChain"] == "bsc"
    assert sent["flashIntegratorFeeBps"] == "50"
    assert resp.get_json()["integratorFeeBps"] == "50"
    assert resp.get_json()["normalized"]["orderType"] == "limit"


@pytest.mark.parametrize("patch,code", [
    ({"targetChain": "sui", "contraChain": "sui"}, "UNSUPPORTED_CHAIN"),
    ({"orderType": "twap"}, "UNSUPPORTED_ORDER"),
    ({"targetChain": "base"}, "UNSUPPORTED_ORDER"),  # cross-chain
    ({"qty": "-1"}, "INVALID_REQUEST"),
    ({"qty": "abc"}, "INVALID_REQUEST"),
    ({"limitNotionalPrice": None}, "INVALID_REQUEST"),
    ({"funderAddress": ""}, "INVALID_REQUEST"),
])
def test_quote_rejects_bad_input(client, patch, code):
    c, app = client
    resp = c.post("/trade/quote", json={**QUOTE, **patch})
    assert resp.status_code == 400
    assert resp.get_json()["error"]["code"] == code
    assert app.flash_calls == []


def test_order_forwards_signature_and_records_row(client):
    c, app = client
    body = {**QUOTE, "quoteId": "q1", "userSignature": "0xsig", "evmOrderTypedData": "{}",
            "meta": {"pair_id": "0xpair", "token_symbol": "TKN", "quote_notional_usd": "2.00"}}
    resp = c.post("/trade/order", json=body)
    assert resp.status_code == 201
    _, path, sent, _ = app.flash_calls[0]
    assert path == "/order"
    assert sent["userSignature"] == "0xsig" and sent["quoteId"] == "q1"
    assert sent["flashIntegratorFeeBps"] == "50"
    assert "meta" not in sent
    verb, values = app.config["WRITE_DB"].executed[0]
    assert verb == "INSERT"
    assert values[0] == "o1" and values[1] == "4242" and values[3] == "bsc"
    assert values[6] == "TKN" and values[12] == 50 and values[13] == "0.5"


def test_order_strips_quote_only_fields(client):
    c, app = client
    body = {**QUOTE, "quoteId": "q1", "userSignature": "0xsig", "expireTime": "2026-12-01T00:00:00Z",
            "evmUsePermit2": False, "forceMinimalAllowance": True}
    assert c.post("/trade/order", json=body).status_code == 201
    _, _, sent, _ = app.flash_calls[0]
    assert not {"expireTime", "evmUsePermit2", "forceMinimalAllowance"} & set(sent)
    # ...but they are still forwarded on the quote
    c.post("/trade/quote", json={**QUOTE, "expireTime": "2026-12-01T00:00:00Z"})
    assert app.flash_calls[1][2]["expireTime"] == "2026-12-01T00:00:00Z"


def test_order_requires_signature(client):
    c, app = client
    resp = c.post("/trade/order", json={**QUOTE, "quoteId": "q1"})
    assert resp.status_code == 400 and app.flash_calls == []


def test_order_survives_db_failure(client):
    c, app = client

    def boom(**kw):
        raise RuntimeError("db down")
    app.config["WRITE_DB"].execute_query = boom
    resp = c.post("/trade/order", json={**QUOTE, "quoteId": "q1", "userSignature": "0xsig"})
    assert resp.status_code == 201 and resp.get_json()["orderId"] == "o1"


def test_get_order_syncs_status_and_fill(client):
    c, app = client
    resp = c.get("/trade/orders/o1?funderAddress=0xfunder")
    assert resp.status_code == 200
    verb, values = app.config["WRITE_DB"].executed[0]
    assert verb == "UPDATE"
    assert values[0] == "ORDER_STATUS_FILLED" and values[1] == "0xabc" and values[2] == "2.01"
    assert values[3] == "o1" and values[4] == "4242"


def test_orders_and_get_require_funder(client):
    c, _ = client
    assert c.get("/trade/orders").status_code == 400
    assert c.get("/trade/orders/o1").status_code == 400
    assert c.get("/trade/orders?funderAddress=0xf&statuses=ORDER_STATUS_ACCEPTED").status_code == 200


def test_list_orders_syncs_statuses(client):
    c, app = client
    resp = c.get("/trade/orders?funderAddress=0xfunder")
    assert resp.status_code == 200
    updates = app.config["WRITE_DB"].executed
    assert [v[2] for _, v in updates] == ["o-old", "o-rest", "o-sell"]  # None orderId skipped
    by_id = {v[2]: v for _, v in updates}
    assert by_id["o-old"][0] == "ORDER_STATUS_FILLED" and by_id["o-old"][1] == "5"
    assert by_id["o-rest"][0] == "ORDER_STATUS_ACCEPTED" and by_id["o-rest"][1] is None
    assert by_id["o-sell"][1] == "2.00"  # 100 * 0.02
    assert all(v[3] == "4242" for v in by_id.values())


def test_list_sync_db_failure_does_not_break_response(client):
    c, app = client

    def boom(**kw):
        raise RuntimeError("db down")
    app.config["WRITE_DB"].execute_query = boom
    assert c.get("/trade/orders?funderAddress=0xfunder").status_code == 200


def test_my_orders_lists_rows_and_refreshes_open_ones(client):
    c, app = client
    import datetime
    from decimal import Decimal
    row = lambda oid, status, funder: (oid, "base", "0xtok", "0xpair", "UP", "limit", "buy", Decimal("2"), "0xusdc",
                                       Decimal("2.0"), None, 50, Decimal("0.06"), status, None,
                                       datetime.datetime(2026, 11, 5, 22, 1, 5), datetime.datetime(2026, 11, 5, 22, 1, 8), funder)
    app.config["READ_DB"].rows = {"MINE": [row("o-open", "ORDER_STATUS_ACCEPTED", "0xfunder"),
                                           row("o-done", "ORDER_STATUS_FILLED", "0xfunder")]}
    resp = c.get("/trade/mine")
    assert resp.status_code == 200
    body = resp.get_json()["orders"]
    assert [o["orderId"] for o in body] == ["o-open", "o-done"]
    assert body[0]["qty"] == "2" and body[0]["placedAt"] == "2026-11-05T22:01:05"
    assert body[0]["funderAddress"] == "0xfunder"
    # one Flash list call for the one funder with an open row, and its rows synced
    assert [p for _, p, _, _ in app.flash_calls] == ["/orders"]
    assert app.flash_calls[0][3]["funderAddress"] == "0xfunder"
    assert app.config["WRITE_DB"].executed  # statuses from the fake list were folded in


def test_my_orders_no_flash_call_when_nothing_open(client):
    c, app = client
    app.config["READ_DB"].rows = {"MINE": []}
    assert c.get("/trade/mine").get_json() == {"orders": []}
    assert app.flash_calls == []


def test_cancel_marks_row(client):
    c, app = client
    resp = c.post("/trade/orders/o1/cancel", json={"cancelMessage": "m", "userSignature": "s"})
    assert resp.status_code == 200
    verb, values = app.config["WRITE_DB"].executed[0]
    assert verb == "UPDATE" and values[0] == "ORDER_STATUS_CANCELLED"
    assert c.post("/trade/orders/o1/cancel", json={}).status_code == 400


def test_token_summary_truncates_funder(client):
    c, app = client
    import datetime
    app.config["READ_DB"].rows = {
        "COUNT": [(3, 2)],
        "ROWS": [("limit", "buy", "0x1234567890abcdef1234567890abcdef12345678", "ORDER_STATUS_FILLED",
                  datetime.datetime(2026, 11, 6, 1, 0, 0))],
    }
    body = c.get("/trade/token/binance/0xTOKEN/orders").get_json()
    assert body["count"] == 3 and body["traders"] == 2
    assert body["recent"][0]["funder"] == "0x1234…5678"
    assert "tg_id" not in str(body)
    assert c.get("/trade/token/sui/0x/orders").get_json()["count"] == 0


def test_unconfigured_server_returns_503(monkeypatch):
    monkeypatch.delenv("FLASH_API_KEY", raising=False)
    app = Flask(__name__)
    with app.app_context():
        body, status, _ = flash_client.flash_request("POST", "/quote", json_body={})
    assert status == 503 and body["error"]["code"] == "TRADING_NOT_CONFIGURED"


def test_fee_clamped(monkeypatch):
    monkeypatch.setenv("FLASH_INTEGRATOR_FEE_BPS", "5000")
    assert flash_client.integrator_fee_bps() == "1000"
    monkeypatch.setenv("FLASH_INTEGRATOR_FEE_BPS", "junk")
    assert flash_client.integrator_fee_bps() == "0"
