import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './TradeDrawer.scss';
import CrossIcon from 'icons/CrossIcon';
import { CHAIN_ICONS } from '@constants/constants';
import { useTradeStore, TradeStep } from './useTradeStore';
import { CHAIN_LABELS, EVM_CHAIN_IDS, EXPLORER_TX_BY_CHAIN, USDC_BY_CHAIN, normalizeChain } from './chains';
import {
  connect,
  getChainId,
  getErc20Balance,
  getProvider,
  isUserRejection,
  personalSign,
  sendTransaction,
  shortAddress,
  signTypedDataV4,
  switchChain,
  waitForReceipt,
} from './evmWallet';
import {
  FlashOrder,
  OrderType,
  QuoteRequest,
  QuoteResponse,
  TERMINAL_STATUSES,
  cancelMessageFor,
  cancelOrder,
  describeApiError,
  getOrder,
  getOrders,
  postOrder,
  postQuote,
} from './trade.service';

/** Flash accepts quotes without a real funder; used for the live preview before a wallet is connected. */
const PREVIEW_FUNDER = '0x000000000000000000000000000000000000dEaD';
const QUICK_AMOUNTS = ['2', '5', '10', '25'];
const USDC_ICON = 'https://assets.coingecko.com/coins/images/6319/small/usdc.png';
// Preview quotes refresh on this cadence while the drawer is idle (well under Flash's 5 req/s).
const PREVIEW_REFRESH_MS = 15_000;

const fmt = (v?: string | number | null, digits = 6): string => {
  if (v === null || v === undefined || v === '') return '–';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toPrecision(digits).replace(/\.?0+$/, '');
};

const impliedPrice = (q: QuoteResponse | null): number | null => {
  if (!q) return null;
  const notional = Number(q.from?.notional);
  const amount = Number(q.to?.amount);
  if (!Number.isFinite(notional) || !Number.isFinite(amount) || amount <= 0) return null;
  return notional / amount;
};

const statusLabel = (s?: string | null) => (s || '').replace('ORDER_STATUS_', '').replace(/_/g, ' ').toLowerCase();

const relTime = (iso?: string | null): string => {
  if (!iso) return '';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
};

type ExpiryKey = '1h' | '24h' | '7d' | 'gtc';
const EXPIRY_OPTIONS: { key: ExpiryKey; label: string; ms: number | null }[] = [
  { key: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { key: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'gtc', label: 'Never (GTC)', ms: null },
];
const LIMIT_PRESETS: { label: string; pct: number }[] = [
  { label: 'Market', pct: 0 },
  { label: '−2%', pct: -2 },
  { label: '−5%', pct: -5 },
  { label: '−10%', pct: -10 },
];
const priceAtPct = (spot: number, pct: number): string => fmt(spot * (1 + pct / 100), 6).replace(/,/g, '');

const STEP_ORDER: { key: TradeStep; label: string }[] = [
  { key: 'quoting', label: 'Quote' },
  { key: 'approving', label: 'Approve' },
  { key: 'signing', label: 'Sign' },
  { key: 'submitting', label: 'Submit' },
  { key: 'placed', label: 'Fill' },
];

const Spinner = () => <span className="flash-spinner" aria-hidden="true" />;

const TradeDrawer: React.FC = () => {
  const {
    isOpen,
    token,
    address,
    chainId,
    step,
    error,
    orderId,
    order,
    fills,
    closeDrawer,
    setWallet,
    setStep,
    setQuote,
    setPlaced,
    setOrderState,
    reset,
  } = useTradeStore();

  const [tab, setTab] = useState<'trade' | 'orders'>('trade');
  const [orderType, setOrderType] = useState<OrderType>('limit');
  const [amount, setAmount] = useState('5');
  const [limitPrice, setLimitPrice] = useState('');
  const [preview, setPreview] = useState<QuoteResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [orders, setOrders] = useState<FlashOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [customPct, setCustomPct] = useState('');
  const [expiry, setExpiry] = useState<ExpiryKey>('1h');
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const limitTouched = useRef(false);
  const submitFailed = useRef(false);

  const chain = normalizeChain(token?.chain);
  const wantedChainId = chain ? EVM_CHAIN_IDS[chain] : undefined;
  const usdc = chain ? USDC_BY_CHAIN[chain] : undefined;
  const chainLabel = chain ? CHAIN_LABELS[chain] || chain : '';
  const chainIcon = chain ? CHAIN_ICONS[chain] : undefined;
  const explorer = chain ? EXPLORER_TX_BY_CHAIN[chain] : undefined;
  const wrongNetwork = !!address && !!wantedChainId && chainId !== wantedChainId;
  const busy = ['connecting', 'switching', 'quoting', 'approving', 'signing', 'submitting'].includes(step);
  const symbol = token?.token_symbol || '';
  const change24 = Number(token?.pc_24_hr);

  const baseRequest = useCallback(
    (funder: string, type: OrderType, price: string): QuoteRequest | null => {
      if (!chain || !usdc || !token?.token_id) return null;
      const req: QuoteRequest = {
        targetChain: chain,
        contraChain: chain,
        targetAsset: token.token_id,
        contraAsset: usdc.address,
        side: 'buy',
        qty: amount,
        orderType: type,
        funderAddress: funder,
      };
      if (type === 'limit') {
        req.limitNotionalPrice = price;
        const ms = EXPIRY_OPTIONS.find(o => o.key === expiry)?.ms;
        if (ms) req.expireTime = new Date(Date.now() + ms).toISOString();
      }
      return req;
    },
    [chain, usdc, token?.token_id, amount, expiry],
  );

  // Reset the form whenever a new token opens the drawer.
  useEffect(() => {
    if (!isOpen) return;
    setTab('trade');
    setPreview(null);
    setPreviewError(null);
    setTxHash(null);
    setPollTimedOut(false);
    setLimitPrice('');
    setCustomPct('');
    setCopied(false);
    limitTouched.current = false;
  }, [isOpen, token?.token_id]);

  // Follow wallet account / chain changes.
  useEffect(() => {
    const provider = getProvider();
    if (!provider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      setWallet(accounts?.[0] ?? null, useTradeStore.getState().chainId);
    };
    const onChain = (...args: unknown[]) => {
      setWallet(useTradeStore.getState().address, parseInt(args[0] as string, 16));
    };
    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, [setWallet]);

  // USDC balance of the connected wallet on the token's chain.
  const refreshBalance = useCallback(async () => {
    if (!address || !usdc || wrongNetwork) {
      setUsdcBalance(null);
      return;
    }
    setUsdcBalance(await getErc20Balance(usdc.address, address, usdc.decimals));
  }, [address, usdc, wrongNetwork]);

  useEffect(() => {
    if (isOpen) refreshBalance();
  }, [isOpen, refreshBalance, step]);

  // Live preview quote (debounced). A limit without a price is previewed as market so we
  // can prefill the limit price from the implied spot.
  useEffect(() => {
    if (!isOpen || !chain || !usdc) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setPreview(null);
      return;
    }
    const price = limitPrice.trim();
    const type: OrderType = orderType === 'limit' && price ? 'limit' : 'market';
    const req = baseRequest(address || PREVIEW_FUNDER, type, price);
    if (!req) return;
    let cancelled = false;
    setPreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const q = await postQuote(req);
        if (cancelled) return;
        setPreview(q);
        setQuotedAt(Date.now());
        setPreviewError(null);
        if (orderType === 'limit' && !limitTouched.current && !price) {
          const p = impliedPrice(q);
          if (p) setLimitPrice(priceAtPct(p, 0));
        }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(describeApiError(err, 'Could not get a quote'));
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, chain, usdc, amount, orderType, limitPrice, address, baseRequest, refreshTick]);

  // Keep the preview fresh while the user is just looking: re-quote every 15 s when
  // nothing is in progress and no order is placed. Also drive the "updated Ns ago" label.
  useEffect(() => {
    if (!isOpen || tab !== 'trade' || busy || step === 'placed' || step === 'filled') return;
    const quote = setInterval(() => setRefreshTick(n => n + 1), PREVIEW_REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(quote);
      clearInterval(clock);
    };
  }, [isOpen, tab, busy, step]);

  // Poll the placed order until it reaches a terminal status (3 min cap for resting orders).
  useEffect(() => {
    if (step !== 'placed' || !orderId || !address) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await getOrder(orderId, address);
        if (stopped) return;
        setOrderState(res.order, res.fills || []);
        const s = res.order?.status;
        if (s === 'ORDER_STATUS_FILLED') setStep('filled');
        else if (s && TERMINAL_STATUSES.has(s)) {
          const why = res.order?.closeReason
            ? `: ${res.order.closeReason.replace('REASON_', '').replace(/_/g, ' ').toLowerCase()}`
            : '';
          setStep('failed', `Order ${statusLabel(s)}${why}`);
        }
      } catch {
        /* transient; keep polling */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    const cap = setTimeout(
      () => {
        stopped = true;
        clearInterval(id);
        setPollTimedOut(true);
      },
      3 * 60 * 1000,
    );
    return () => {
      stopped = true;
      clearInterval(id);
      clearTimeout(cap);
    };
  }, [step, orderId, address, setOrderState, setStep]);

  const loadOrders = useCallback(async () => {
    if (!address) return;
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const res = await getOrders(address);
      const mine = (res.orders || []).filter(
        o => !token?.token_id || o.targetAsset?.address?.toLowerCase() === token.token_id.toLowerCase(),
      );
      setOrders(mine);
    } catch (err) {
      setOrdersError(describeApiError(err, 'Could not load orders'));
    } finally {
      setOrdersLoading(false);
    }
  }, [address, token?.token_id]);

  useEffect(() => {
    if (tab === 'orders' && isOpen) loadOrders();
  }, [tab, isOpen, loadOrders]);

  const ensureWallet = async (): Promise<string> => {
    let addr = address;
    if (!addr) {
      setStep('connecting');
      addr = await connect();
      const id = await getChainId();
      setWallet(addr, id);
      if (wantedChainId && id !== wantedChainId) {
        setStep('switching');
        await switchChain(wantedChainId);
        setWallet(addr, wantedChainId);
      }
      return addr;
    }
    if (wrongNetwork && wantedChainId) {
      setStep('switching');
      await switchChain(wantedChainId);
      setWallet(addr, wantedChainId);
    }
    return addr;
  };

  /** Connect (and switch network) and stop there. Placing an order is always a separate, explicit click. */
  const connectOnly = async () => {
    try {
      await ensureWallet();
      setStep('idle');
    } catch (err) {
      setStep('failed', isUserRejection(err) ? 'Cancelled in wallet' : (err as Error)?.message || 'Could not connect');
    }
  };

  const snapshotOrderIds = async (funder: string): Promise<Set<string> | null> => {
    try {
      const res = await getOrders(funder);
      return new Set((res.orders || []).map(o => o.orderId));
    } catch {
      return null;
    }
  };

  const findCreatedOrder = async (
    funder: string,
    submitted: { side: string; qty: string; orderType: string; targetAsset: string; contraAsset: string },
    priorIds: Set<string> | null,
  ): Promise<FlashOrder | undefined> => {
    const same = (a?: string, b?: string) => (a || '').toLowerCase() === (b || '').toLowerCase();
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const res = await getOrders(funder);
        const hit = (res.orders || []).find(
          o =>
            (priorIds ? !priorIds.has(o.orderId) : true) &&
            o.side === submitted.side &&
            o.qty === submitted.qty &&
            o.orderType === submitted.orderType &&
            same(o.targetAsset?.address, submitted.targetAsset) &&
            same(o.contraAsset?.address, submitted.contraAsset),
        );
        if (hit) return hit;
      } catch {
        /* list is eventually consistent; keep trying */
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return undefined;
  };

  const place = async () => {
    submitFailed.current = false;
    try {
      const funder = await ensureWallet();
      if (!chain || !usdc) throw new Error('This chain is not enabled for Flash trading');
      const price = limitPrice.trim();
      if (orderType === 'limit' && !price) throw new Error('Enter a limit price');
      if (usdcBalance !== null && Number(amount) > Number(usdcBalance)) {
        throw new Error(`Not enough USDC: you have ${fmt(usdcBalance, 4)}`);
      }

      setStep('quoting');
      let q = await postQuote(baseRequest(funder, orderType, price) as QuoteRequest);
      setQuote(q);
      if (q.wrap?.evmTx) throw new Error('Native-asset wrap is not supported in v1; buy with USDC');

      if (q.evm?.approveTx) {
        setStep('approving');
        const hash = await sendTransaction({ from: funder, to: q.evm.approveTx.to, data: q.evm.approveTx.data });
        setTxHash(hash);
        await waitForReceipt(hash);
        // The market deadline is short; re-quote after the approval lands.
        setStep('quoting');
        q = await postQuote(baseRequest(funder, orderType, price) as QuoteRequest);
        setQuote(q);
      }
      if (!q.evm?.orderTypedData) throw new Error('Flash returned no signing payload');

      setStep('signing');
      let permitSignature: string | undefined;
      if (q.evm.permitTypedData) permitSignature = await signTypedDataV4(funder, q.evm.permitTypedData);
      const signature = await signTypedDataV4(funder, q.evm.orderTypedData);

      setStep('submitting');
      const submitBody = {
        ...(baseRequest(funder, orderType, price) as QuoteRequest),
        targetAsset: q.targetAsset || (token?.token_id as string),
        contraAsset: q.contraAsset || usdc.address,
        quoteId: q.quoteId,
        userSignature: signature,
        evmOrderTypedData: q.evm.orderTypedData,
        evmPermitTypedData: q.evm.permitTypedData || undefined,
        evmPermitSignature: permitSignature,
        meta: { pair_id: token?.pair_id, token_symbol: symbol, quote_notional_usd: q.from?.notional },
      };
      // Flash's /order has been seen to create (even fill) an order and still answer 4xx.
      // Snapshot first so an error is reconciled instead of retried (a retry double-spends).
      const priorIds = await snapshotOrderIds(funder);
      try {
        const res = await postOrder(submitBody);
        setPlaced(res.orderId);
      } catch (submitErr) {
        const recovered = await findCreatedOrder(funder, submitBody, priorIds);
        if (recovered) {
          setPlaced(recovered.orderId);
          return;
        }
        submitFailed.current = true;
        throw submitErr;
      }
    } catch (err) {
      const msg = isUserRejection(err)
        ? 'Cancelled in wallet'
        : describeApiError(err, (err as Error)?.message || 'Order failed');
      setStep('failed', submitFailed.current ? `${msg}. Check the Orders tab before placing again.` : msg);
    }
  };

  const cancel = async (o: FlashOrder) => {
    if (!address) return;
    setCancelling(o.orderId);
    setOrdersError(null);
    try {
      const sig = await personalSign(address, cancelMessageFor(o.orderId));
      await cancelOrder(o.orderId, cancelMessageFor(o.orderId), sig);
      await loadOrders();
      if (o.orderId === orderId) setStep('failed', 'Order cancelled');
    } catch (err) {
      setOrdersError(isUserRejection(err) ? 'Cancelled in wallet' : describeApiError(err, 'Cancel failed'));
    } finally {
      setCancelling(null);
    }
  };

  const copyOrderId = async () => {
    if (!orderId) return;
    try {
      await navigator.clipboard.writeText(orderId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; ignore */
    }
  };

  const newOrder = () => {
    reset();
    setTxHash(null);
    setPollTimedOut(false);
    setCopied(false);
  };

  const primaryLabel = useMemo(() => {
    if (!address) return 'Connect wallet';
    if (wrongNetwork) return `Switch to ${chainLabel}`;
    switch (step) {
      case 'connecting':
        return 'Connecting…';
      case 'switching':
        return 'Switching network…';
      case 'quoting':
        return 'Getting quote…';
      case 'approving':
        return 'Approve USDC in wallet…';
      case 'signing':
        return 'Sign order in wallet…';
      case 'submitting':
        return 'Placing order…';
      case 'placed':
        return pollTimedOut ? 'Resting with Flash' : 'Waiting for fill…';
      case 'filled':
        return 'Filled';
      case 'failed':
        return 'Try again';
      default:
        return orderType === 'limit' ? 'Place limit order' : 'Place market order';
    }
  }, [address, wrongNetwork, chainLabel, step, orderType, pollTimedOut]);

  if (!isOpen || !token) return null;

  const fillTx = fills.find(f => f.transactionId)?.transactionId;
  const feePaid = fills.reduce((s, f) => s + Number(f.feeNotional || 0), 0);
  const stepIndex = STEP_ORDER.findIndex(s => s.key === step);
  const showSteps = stepIndex >= 0 || step === 'filled';
  const spot = impliedPrice(preview);
  const canPlace = !!usdc && (!address || wrongNetwork || step === 'failed' || (!!preview && !previewError));
  const shareMine = `I just traded $${symbol} on askRoger with @DefinitiveFi Flash. Trade the signal:`;
  const shareUrl = `https://x.com/intent/post?text=${encodeURIComponent(shareMine)}&url=${encodeURIComponent(window.location.href)}`;

  return (
    <>
      <div className="flash-drawer-backdrop" onClick={closeDrawer} />
      <aside className="flash-drawer" role="dialog" aria-label="Trade with Flash">
        <div className="flash-head">
          {token.profile_image_url ? (
            <img className="flash-head__logo" src={token.profile_image_url} alt="" />
          ) : (
            <div className="flash-head__logo flash-head__logo--empty">{symbol.slice(0, 2)}</div>
          )}
          <div className="flash-head__main">
            <div className="flash-head__title">
              <span>⚡ Trade</span>
              <span className="flash-head__symbol">${symbol}</span>
            </div>
            <div className="flash-head__meta">
              <span className="flash-chain">
                {chainIcon && <img src={chainIcon} alt="" />}
                {chainLabel}
              </span>
              <span>·</span>
              <span className="flash-head__price">{spot ? `$${fmt(spot)}` : previewLoading ? '…' : '–'}</span>
              {Number.isFinite(change24) && change24 !== 0 && (
                <span className={change24 > 0 ? 'up' : 'down'}>
                  {change24 > 0 ? '▲' : '▼'} {Math.abs(change24).toFixed(1)}% 24h
                </span>
              )}
            </div>
          </div>
          <button className="flash-close" onClick={closeDrawer} aria-label="Close">
            <CrossIcon color="currentColor" />
          </button>
        </div>

        <div className="flash-seg flash-tabs">
          <button className={tab === 'trade' ? 'active' : ''} onClick={() => setTab('trade')}>
            Trade
          </button>
          <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>
            Orders
          </button>
        </div>

        <div className="flash-body">
          <div className="flash-wallet">
            {address ? (
              <>
                <span className="flash-wallet__addr">{shortAddress(address)}</span>
                <span className={`flash-wallet__net ${wrongNetwork ? 'wrong' : ''}`}>
                  {!wrongNetwork && chainIcon && <img src={chainIcon} alt="" />}
                  {wrongNetwork ? `Wrong network · switch to ${chainLabel}` : chainLabel}
                </span>
              </>
            ) : (
              <>
                <span className="flash-wallet__none">No wallet connected</span>
                <button className="flash-connect" onClick={connectOnly} disabled={busy}>
                  Connect
                </button>
              </>
            )}
          </div>

          {tab === 'trade' && (
            <>
              <div className="flash-seg">
                <button
                  className={orderType === 'market' ? 'active' : ''}
                  disabled={busy}
                  onClick={() => setOrderType('market')}>
                  Market
                </button>
                <button
                  className={orderType === 'limit' ? 'active' : ''}
                  disabled={busy}
                  onClick={() => setOrderType('limit')}>
                  Limit
                </button>
              </div>

              <div className="flash-field">
                <div className="flash-field__row">
                  <span>You pay</span>
                  {usdcBalance !== null && (
                    <span className="flash-balance">
                      Balance {fmt(usdcBalance, 4)} USDC
                      <button
                        disabled={busy}
                        onClick={() => setAmount((Math.floor(Number(usdcBalance) * 100) / 100).toString())}>
                        Max
                      </button>
                    </span>
                  )}
                </div>
                <div className="flash-input">
                  <input
                    inputMode="decimal"
                    value={amount}
                    disabled={busy}
                    onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="0"
                  />
                  <span className="flash-unit">
                    <img src={USDC_ICON} alt="" />
                    USDC
                  </span>
                </div>
                <div className="flash-quick">
                  {QUICK_AMOUNTS.map(a => (
                    <button
                      key={a}
                      className={amount === a ? 'active' : ''}
                      disabled={busy}
                      onClick={() => setAmount(a)}>
                      ${a}
                    </button>
                  ))}
                </div>
              </div>

              {orderType === 'limit' && (
                <>
                  <div className="flash-field">
                    <div className="flash-field__row">
                      <span className="flash-limit-label">
                        When 1 {symbol} is worth
                        {spot && limitPrice && Number(limitPrice) > 0 && (
                          <span
                            className={`pill pct ${Number(limitPrice) / spot - 1 < -0.0005 ? 'ok' : Number(limitPrice) / spot - 1 > 0.0005 ? 'wait' : ''}`}>
                            {((Number(limitPrice) / spot - 1) * 100).toFixed(1)}%
                          </span>
                        )}
                      </span>
                      {spot && (
                        <button
                          className="flash-reset"
                          disabled={busy}
                          onClick={() => {
                            limitTouched.current = true;
                            setCustomPct('');
                            setLimitPrice(priceAtPct(spot, 0));
                          }}>
                          Reset
                        </button>
                      )}
                    </div>
                    <div className="flash-input">
                      <input
                        inputMode="decimal"
                        value={limitPrice}
                        disabled={busy}
                        onChange={e => {
                          limitTouched.current = true;
                          setCustomPct('');
                          setLimitPrice(e.target.value.replace(/[^0-9.eE-]/g, ''));
                        }}
                        placeholder="auto from quote"
                      />
                      <span className="flash-unit">USD</span>
                    </div>
                    <div className="flash-quick">
                      {LIMIT_PRESETS.map(pr => {
                        const active =
                          !!spot &&
                          !!limitPrice &&
                          Math.abs((Number(limitPrice) / spot - 1) * 100 - pr.pct) < 0.05 &&
                          !customPct;
                        return (
                          <button
                            key={pr.label}
                            className={active ? 'active' : ''}
                            disabled={busy || !spot}
                            onClick={() => {
                              if (!spot) return;
                              limitTouched.current = true;
                              setCustomPct('');
                              setLimitPrice(priceAtPct(spot, pr.pct));
                            }}>
                            {pr.label}
                          </button>
                        );
                      })}
                      <label className={`flash-custom-pct ${customPct ? 'active' : ''}`}>
                        <span aria-hidden="true">✎</span>
                        <input
                          inputMode="decimal"
                          value={customPct}
                          disabled={busy || !spot}
                          placeholder="0"
                          onChange={e => {
                            const v = e.target.value.replace(/[^0-9.-]/g, '');
                            setCustomPct(v);
                            const pct = Number(v);
                            if (spot && v !== '' && v !== '-' && Number.isFinite(pct)) {
                              limitTouched.current = true;
                              setLimitPrice(priceAtPct(spot, pct));
                            }
                          }}
                        />
                        %
                      </label>
                    </div>
                  </div>
                  <div className="flash-field__row flash-expires">
                    <span>Expires in</span>
                    <select value={expiry} disabled={busy} onChange={e => setExpiry(e.target.value as ExpiryKey)}>
                      {EXPIRY_OPTIONS.map(o => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div className="flash-summary">
                <div className="row big">
                  <span>You receive</span>
                  <span>
                    {previewLoading && !preview ? '…' : fmt(preview?.to?.amount)} {symbol}
                  </span>
                </div>
                <div className="row">
                  <span>{orderType === 'limit' ? 'Spot price' : 'Price'}</span>
                  <span>{spot ? `$${fmt(spot)}` : '–'}</span>
                </div>
                <div className="row">
                  <span>Price impact</span>
                  <span>
                    {preview?.estimatedPriceImpact
                      ? `${(Number(preview.estimatedPriceImpact) * 100).toFixed(2)}%`
                      : '–'}
                  </span>
                </div>
                <div className="row">
                  <span>
                    Fees · Flash + askRoger{' '}
                    {preview?.integratorFeeBps && preview.integratorFeeBps !== '0'
                      ? `${Number(preview.integratorFeeBps) / 100}%`
                      : ''}
                  </span>
                  <span>
                    {preview?.fees?.estimatedFeeNotional ? `$${fmt(preview.fees.estimatedFeeNotional, 4)}` : '–'}
                  </span>
                </div>
                {previewError ? (
                  <div className="flash-error">{previewError}</div>
                ) : (
                  <div className="muted">
                    {orderType === 'limit'
                      ? 'Rests with Flash until your price is reached. Gasless execution, cancel any time.'
                      : 'Executes at the best route Flash finds. Flash pays the execution gas.'}
                    {quotedAt && preview && (
                      <span className="flash-updated">
                        {previewLoading
                          ? ' · updating…'
                          : ` · updated ${Math.max(0, Math.round((now - quotedAt) / 1000))}s ago`}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {showSteps && (
                <div className="flash-steps">
                  {STEP_ORDER.map((s, i) => (
                    <span
                      key={s.key}
                      className={`step ${step === s.key ? 'on' : ''} ${step === 'filled' || (stepIndex > i && stepIndex >= 0) ? 'done' : ''}`}>
                      {s.label}
                    </span>
                  ))}
                </div>
              )}

              {error && <div className="flash-error">{error}</div>}

              {step === 'filled' && (
                <div className="flash-status ok">
                  <div className="flash-status__big">
                    <span className="check">✓</span>
                    Filled {fmt(order?.filled?.targetAmount)} {symbol}
                  </div>
                  <div className="flash-status__kv">
                    <span>Average price</span>
                    <span>${fmt(order?.filled?.averageNotionalPrice || order?.filled?.averagePrice)}</span>
                  </div>
                  <div className="flash-status__kv">
                    <span>Spent</span>
                    <span>{fmt(order?.filled?.contraAmount || order?.qty, 4)} USDC</span>
                  </div>
                  {feePaid > 0 && (
                    <div className="flash-status__kv">
                      <span>Fees paid</span>
                      <span>${fmt(feePaid, 4)}</span>
                    </div>
                  )}
                  <div className="mono">
                    {orderId}
                    <button onClick={copyOrderId}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                  <div className="flash-actions">
                    {fillTx && explorer && (
                      <a
                        className="flash-link-btn"
                        href={`${explorer}${fillTx}`}
                        target="_blank"
                        rel="noopener noreferrer">
                        View onchain ↗
                      </a>
                    )}
                    <a className="flash-link-btn x" href={shareUrl} target="_blank" rel="noopener noreferrer">
                      Share on X
                    </a>
                  </div>
                </div>
              )}

              {(step === 'placed' || (step === 'failed' && orderId)) && (
                <div className={`flash-status ${step === 'failed' ? 'bad' : ''}`}>
                  <div className="flash-status__top">
                    <span>Order</span>
                    <span className={`pill ${step === 'failed' ? 'bad' : 'wait'}`}>
                      {statusLabel(order?.status) || (step === 'placed' ? 'pending' : step)}
                    </span>
                  </div>
                  <div className="mono">
                    {orderId}
                    <button onClick={copyOrderId}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                  {pollTimedOut && step === 'placed' && (
                    <div className="hint">
                      Resting with Flash until your price is reached. Track or cancel it in the Orders tab.
                    </div>
                  )}
                  {txHash && explorer && (
                    <a
                      className="flash-link-btn"
                      href={`${explorer}${txHash}`}
                      target="_blank"
                      rel="noopener noreferrer">
                      View approval onchain ↗
                    </a>
                  )}
                </div>
              )}

              {step === 'placed' || step === 'filled' ? (
                <>
                  <button className={`flash-primary ${step === 'filled' ? 'ok' : ''}`} disabled>
                    {step === 'placed' && !pollTimedOut && <Spinner />}
                    {step === 'filled' ? '✓ ' : ''}
                    {primaryLabel}
                  </button>
                  <button className="flash-secondary" onClick={newOrder}>
                    New order
                  </button>
                </>
              ) : (
                <button
                  className="flash-primary"
                  disabled={busy || !canPlace}
                  onClick={() => {
                    if (!address || wrongNetwork) return connectOnly();
                    if (step === 'failed') reset();
                    return place();
                  }}>
                  {busy && <Spinner />}
                  {primaryLabel}
                </button>
              )}
            </>
          )}

          {tab === 'orders' && (
            <div className="flash-orders">
              {!address && <div className="empty">Connect a wallet to see its Flash orders.</div>}
              {address && ordersLoading && orders.length === 0 && <div className="empty">Loading…</div>}
              {address && !ordersLoading && orders.length === 0 && !ordersError && (
                <div className="empty">
                  No Flash orders for ${symbol} from {shortAddress(address)} yet.
                  <br />
                  Place one from the Trade tab.
                </div>
              )}
              {ordersError && <div className="flash-error">{ordersError}</div>}
              {orders.map(o => {
                const open = !TERMINAL_STATUSES.has(o.status);
                const filled = o.status === 'ORDER_STATUS_FILLED';
                return (
                  <div className="flash-order" key={o.orderId}>
                    <div className="top">
                      <span>
                        {o.side} {o.orderType} · {fmt(o.qty, 4)}{' '}
                        {o.side === 'buy' ? 'USDC' : o.targetAsset?.ticker || ''}
                      </span>
                      <span className={`pill ${filled ? 'ok' : open ? 'wait' : 'bad'}`}>{statusLabel(o.status)}</span>
                    </div>
                    <div className="meta">
                      <span>
                        {o.limitNotionalPrice ? `limit $${fmt(o.limitNotionalPrice)}` : ''}
                        {o.limitNotionalPrice && o.filled?.averageNotionalPrice ? ' · ' : ''}
                        {o.filled?.averageNotionalPrice ? `avg $${fmt(o.filled.averageNotionalPrice)}` : ''}
                      </span>
                      <span>{relTime(o.placedAt)}</span>
                    </div>
                    {open && (
                      <button className="cancel" disabled={cancelling === o.orderId} onClick={() => cancel(o)}>
                        {cancelling === o.orderId ? 'Cancelling…' : 'Cancel order'}
                      </button>
                    )}
                  </div>
                );
              })}
              {address && (
                <button className="flash-secondary" onClick={loadOrders} disabled={ordersLoading}>
                  {ordersLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              )}
            </div>
          )}

          <div className="flash-foot">
            Powered by{' '}
            <a href="https://flash.definitive.fi/docs" target="_blank" rel="noopener noreferrer">
              Definitive Flash
            </a>
            . Non-custodial: your tokens stay in your wallet until the order executes.
          </div>
        </div>
      </aside>
    </>
  );
};

export default TradeDrawer;
