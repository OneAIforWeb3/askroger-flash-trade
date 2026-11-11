import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './MyTrades.scss';
import { CHAIN_ICONS } from '@constants/constants';
import { TokenDataItem } from '@customTypes/cashtag.types';
import { useTradeStore } from './useTradeStore';
import { CHAIN_LABELS, EXPLORER_TX_BY_CHAIN, normalizeChain } from './chains';
import { connect, getChainId, isUserRejection, personalSign, shortAddress } from './evmWallet';
import {
  MyOrder,
  TERMINAL_STATUSES,
  cancelMessageFor,
  cancelOrder,
  describeApiError,
  getMyOrders,
} from './trade.service';

const fmt = (v?: string | number | null, digits = 6): string => {
  if (v === null || v === undefined || v === '') return '–';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toPrecision(digits).replace(/\.?0+$/, '');
};
const statusLabel = (s?: string | null) => (s || '').replace('ORDER_STATUS_', '').replace(/_/g, ' ').toLowerCase();
const when = (iso: string) => new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString();

/** /app/trades: every Flash order this login placed through askRoger, across tokens and wallets. */
const MyTrades: React.FC = () => {
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const { address, setWallet, openDrawer } = useTradeStore();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOrders((await getMyOrders()).orders);
    } catch (err) {
      setError(describeApiError(err, 'Could not load your trades'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cancel = async (o: MyOrder) => {
    setCancelling(o.orderId);
    setError(null);
    try {
      let addr = address;
      if (!addr) {
        addr = await connect();
        setWallet(addr, await getChainId());
      }
      if (addr.toLowerCase() !== o.funderAddress.toLowerCase()) {
        throw new Error(`Connect the wallet that placed this order (${shortAddress(o.funderAddress)})`);
      }
      const sig = await personalSign(addr, cancelMessageFor(o.orderId));
      await cancelOrder(o.orderId, cancelMessageFor(o.orderId), sig);
      await load();
    } catch (err) {
      setError(
        isUserRejection(err)
          ? 'Cancelled in wallet'
          : describeApiError(err, (err as Error)?.message || 'Cancel failed'),
      );
    } finally {
      setCancelling(null);
    }
  };

  const tradeAgain = (o: MyOrder) => {
    const item: Partial<TokenDataItem> = {
      chain: o.chain,
      token_id: o.tokenId,
      token_symbol: o.tokenSymbol || '',
      pair_id: o.pairId || '',
      is_coin: 0,
    };
    openDrawer(item as TokenDataItem);
  };

  const open = orders.filter(o => !TERMINAL_STATUSES.has(o.status));
  const done = orders.filter(o => TERMINAL_STATUSES.has(o.status));
  const spent = done
    .filter(o => o.status === 'ORDER_STATUS_FILLED')
    .reduce((s, o) => s + Number(o.filledNotionalUsd || o.quoteNotionalUsd || 0), 0);

  const row = (o: MyOrder) => {
    const chain = normalizeChain(o.chain);
    const explorer = chain ? EXPLORER_TX_BY_CHAIN[chain] : undefined;
    const isOpen = !TERMINAL_STATUSES.has(o.status);
    const filled = o.status === 'ORDER_STATUS_FILLED';
    return (
      <div className="my-trade" key={o.orderId}>
        <div className="my-trade__token">
          {chain && CHAIN_ICONS[chain] && <img src={CHAIN_ICONS[chain]} alt="" />}
          <Link to={`/app/cashtags/${o.chain}/${o.tokenId}`}>${o.tokenSymbol || shortAddress(o.tokenId)}</Link>
          <span className="my-trade__chain">{chain ? CHAIN_LABELS[chain] || chain : o.chain}</span>
        </div>
        <div className="my-trade__what">
          <span className="my-trade__type">
            {o.side} {o.orderType}
          </span>
          <span className="my-trade__amt">{fmt(o.qty, 4)} USDC</span>
          {o.limitNotionalPrice && <span className="my-trade__meta">limit ${fmt(o.limitNotionalPrice)}</span>}
        </div>
        <div className="my-trade__status">
          <span className={`pill ${filled ? 'ok' : isOpen ? 'wait' : 'bad'}`}>{statusLabel(o.status)}</span>
          <span className="my-trade__meta">{when(o.placedAt)}</span>
        </div>
        <div className="my-trade__actions">
          {o.fillTx && explorer && (
            <a href={`${explorer}${o.fillTx}`} target="_blank" rel="noopener noreferrer">
              Onchain ↗
            </a>
          )}
          {isOpen && (
            <button className="cancel" disabled={cancelling === o.orderId} onClick={() => cancel(o)}>
              {cancelling === o.orderId ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          <button className="again" onClick={() => tradeAgain(o)}>
            Trade again
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="my-trades-page">
      <div className="my-trades-head">
        <div>
          <h1>⚡ My Flash trades</h1>
          <p>
            Every order you placed through askRoger with Definitive Flash. Non-custodial: funds move only when an order
            fills.
          </p>
        </div>
        <button className="refresh" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="my-trades-stats">
        <div>
          <span className="label">Orders</span>
          <span className="value">{orders.length}</span>
        </div>
        <div>
          <span className="label">Open</span>
          <span className="value">{open.length}</span>
        </div>
        <div>
          <span className="label">Filled volume</span>
          <span className="value">${fmt(spent, 4)}</span>
        </div>
      </div>

      {error && <div className="my-trades-error">{error}</div>}

      {!loading && orders.length === 0 && !error && (
        <div className="my-trades-empty">
          No Flash trades yet. Open any token on Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche or BNB Chain and
          press <strong>⚡ Trade with Flash</strong>.
        </div>
      )}

      {open.length > 0 && (
        <>
          <h2>Open</h2>
          <div className="my-trades-list">{open.map(row)}</div>
        </>
      )}
      {done.length > 0 && (
        <>
          <h2>History</h2>
          <div className="my-trades-list">{done.map(row)}</div>
        </>
      )}
    </div>
  );
};

export default MyTrades;
