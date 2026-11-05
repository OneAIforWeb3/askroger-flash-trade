"""Flash enums, our chain aliases, and the SQL for users.flash_orders."""

FLASH_BASE_URL = "https://flash.definitive.fi/v1"

# `Chain` enum from https://flash.definitive.fi/v1/openapi.json (2026-11-05).
FLASH_CHAINS = frozenset({
    "arbitrum", "avalanche", "base", "bsc", "ethereum", "optimism", "polygon",
    "solana", "hyperevm", "plasma", "monad", "robinhood", "ink", "arc",
})

# Our leaderboard slugs that differ from Flash's.
CHAIN_ALIASES = {"binance": "bsc", "bnb": "bsc"}

# v1: market is the smoke test, limit is the advanced order. The rest of the Flash
# enum (twap, stop, stop-loss, take-profit, bracket, trailing-stop,
# trailing-stop-limit) needs trigger/bracket forms and a second signature.
ALLOWED_ORDER_TYPES = frozenset({"market", "limit"})
ALLOWED_SIDES = frozenset({"buy", "sell"})

# Fields the client may set on a quote; everything else is dropped. The server
# owns flashIntegratorFeeBps.
QUOTE_PASSTHROUGH = (
    "targetChain", "contraChain", "targetAsset", "contraAsset", "side", "qty",
    "orderType", "funderAddress", "maxSlippage", "maxPriceImpact",
    "limitNotionalPrice", "limitCrossPrice", "expireTime", "evmUsePermit2",
    "forceMinimalAllowance",
)

# Quote-time only: Flash's SubmitOrderRequest schema has no such fields and the
# reference implementation (DefinitiveCo/flash-mcp README) says not to send them;
# an unknown field on /order risks a 400 VALIDATION_ERROR after the user signed.
QUOTE_ONLY_FIELDS = frozenset({"expireTime", "evmUsePermit2", "forceMinimalAllowance"})

# Fields echoed from the quote to POST /order plus the signature material.
ORDER_PASSTHROUGH = tuple(f for f in QUOTE_PASSTHROUGH if f not in QUOTE_ONLY_FIELDS) + (
    "quoteId", "userSignature", "evmOrderTypedData", "evmPermitTypedData",
    "evmPermitSignature", "erc8021AttributionCode",
)

ORDER_STATUSES_TERMINAL = frozenset({
    "ORDER_STATUS_FILLED", "ORDER_STATUS_CANCELLED", "ORDER_STATUS_REJECTED",
    "ORDER_STATUS_TERMINATED",
})

INSERT_ORDER_QUERY = """
INSERT INTO users.flash_orders
  (order_id, tg_id, funder_address, chain, token_id, pair_id, token_symbol,
   order_type, side, qty, contra_asset, quote_notional_usd, integrator_fee_bps,
   limit_notional_price, status)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'ORDER_STATUS_PENDING')
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP
"""

UPDATE_ORDER_STATUS_QUERY = """
UPDATE users.flash_orders
   SET status = %s,
       fill_tx = COALESCE(%s, fill_tx),
       filled_notional_usd = COALESCE(%s, filled_notional_usd)
 WHERE order_id = %s AND tg_id = %s
"""

# Status sync from the list endpoint: Flash's list carries no fills, so only the
# status moves here; fill_tx stays whatever the single-order sync last wrote.
# Scoped to the caller's own rows so a wallet shared across accounts cannot
# rewrite someone else's bookkeeping.
UPDATE_ORDER_STATUS_FROM_LIST_QUERY = """
UPDATE users.flash_orders
   SET status = %s,
       filled_notional_usd = COALESCE(%s, filled_notional_usd)
 WHERE order_id = %s AND tg_id = %s AND status <> %s
"""

MY_ORDERS_QUERY = """
SELECT order_id, chain, token_id, pair_id, token_symbol, order_type, side, qty,
       contra_asset, quote_notional_usd, filled_notional_usd, integrator_fee_bps,
       limit_notional_price, status, fill_tx, placed_at, updated_at, funder_address
  FROM users.flash_orders
 WHERE tg_id = %s
 ORDER BY placed_at DESC
 LIMIT 200
"""

TOKEN_ORDERS_SUMMARY_QUERY = """
SELECT order_type, side, funder_address, status, placed_at
  FROM users.flash_orders
 WHERE chain = %s AND LOWER(token_id) = LOWER(%s)
   AND status <> 'ORDER_STATUS_REJECTED'
 ORDER BY placed_at DESC
 LIMIT 10
"""

TOKEN_ORDERS_COUNT_QUERY = """
SELECT COUNT(*), COUNT(DISTINCT tg_id)
  FROM users.flash_orders
 WHERE chain = %s AND LOWER(token_id) = LOWER(%s)
   AND status <> 'ORDER_STATUS_REJECTED'
"""

CREATE_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS users.flash_orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  tg_id VARCHAR(64) NOT NULL,
  funder_address VARCHAR(64) NOT NULL,
  chain VARCHAR(32) NOT NULL,
  token_id VARCHAR(128) NOT NULL,
  pair_id VARCHAR(128) NULL,
  token_symbol VARCHAR(64) NULL,
  order_type VARCHAR(32) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  qty DECIMAL(40,18) NOT NULL,
  contra_asset VARCHAR(128) NOT NULL,
  quote_notional_usd DECIMAL(20,6) NULL,
  filled_notional_usd DECIMAL(20,6) NULL,
  integrator_fee_bps SMALLINT NOT NULL,
  limit_notional_price DECIMAL(40,18) NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'ORDER_STATUS_PENDING',
  fill_tx VARCHAR(128) NULL,
  placed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_order (order_id),
  KEY ix_token (chain, token_id, placed_at),
  KEY ix_user (tg_id, placed_at)
)
"""
