import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './TradeDrawer.scss';
import CrossIcon from 'icons/CrossIcon';
import { useTradeStore, TradeStep } from './useTradeStore';
import { CHAIN_LABELS, EVM_CHAIN_IDS, EXPLORER_TX_BY_CHAIN, USDC_BY_CHAIN, normalizeChain } from './chains';
import {
  connect,
  getChainId,
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

/** Flash accepts quotes without a real funder; we use this for the live preview before a wallet is connected. */
const PREVIEW_FUNDER = '0x000000000000000000000000000000000000dEaD';
const QUICK_AMOUNTS = ['2', '5', '10', '25'];

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

const statusLabel = (s?: string | null) => (s || '').replace('ORDER_STATUS_', '').replace('_', ' ').toLowerCase();

const STEP_ORDER: { key: TradeStep; label: string }[] = [
  { key: 'quoting', label: 'Quote' },
  { key: 'approving', label: 'Approve' },
  { key: 'signing', label: 'Sign' },
  { key: 'submitting', label: 'Submit' },
  { key: 'placed', label: 'Fill' },
];

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
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const limitTouched = useRef(false);

  const chain = normalizeChain(token?.chain);
  const wantedChainId = chain ? EVM_CHAIN_IDS[chain] : undefined;
  const usdc = chain ? USDC_BY_CHAIN[chain] : undefined;
  const chainLabel = chain ? CHAIN_LABELS[chain] || chain : '';
  const explorer = chain ? EXPLORER_TX_BY_CHAIN[chain] : undefined;
  const wrongNetwork = !!address && !!wantedChainId && chainId !== wantedChainId;
  const busy = ['connecting', 'switching', 'quoting', 'approving', 'signing', 'submitting'].includes(step);

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
      if (type === 'limit') req.limitNotionalPrice = price;
      return req;
    },
    [chain, usdc, token?.token_id, amount],
  );

  // Reset the form whenever a new token opens the drawer.
  useEffect(() => {
    if (!isOpen) return;
    setTab('trade');
    setPreview(null);
    setPreviewError(null);
    setTxHash(null);
    setLimitPrice('');
    limitTouched.current = false;
  }, [isOpen, token?.token_id]);

  // Wallet: remember an already-connected account, follow account/chain changes.
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
        setPreviewError(null);
        if (orderType === 'limit' && !limitTouched.current && !price) {
          const p = impliedPrice(q);
          if (p) setLimitPrice(fmt(p * 1.01, 6).replace(/,/g, ''));
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
  }, [isOpen, chain, usdc, amount, orderType, limitPrice, address, baseRequest]);

  // Poll the placed order until it reaches a terminal status.
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
        else if (s && TERMINAL_STATUSES.has(s))
          setStep(
            'failed',
            `Order ${statusLabel(s)}${res.order?.closeReason ? `: ${res.order.closeReason.replace('REASON_', '').replace(/_/g, ' ').toLowerCase()}` : ''}`,
          );
      } catch {
        /* transient; keep polling */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [step, orderId, address, setOrderState, setStep]);

  const loadOrders = useCallback(async () => {
    if (!address) return;
    setOrdersLoading(true);
    try {
      const res = await getOrders(address);
      const mine = (res.orders || []).filter(
        o => !token?.token_id || o.targetAsset?.address?.toLowerCase() === token.token_id.toLowerCase(),
      );
      setOrders(mine);
    } catch (err) {
      setPreviewError(describeApiError(err, 'Could not load orders'));
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

  const place = async () => {
    try {
      const funder = await ensureWallet();
      if (!chain || !usdc) throw new Error('This chain is not enabled for Flash trading');
      const price = limitPrice.trim();
      if (orderType === 'limit' && !price) throw new Error('Enter a limit price');

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
      const res = await postOrder({
        ...(baseRequest(funder, orderType, price) as QuoteRequest),
        quoteId: q.quoteId,
        userSignature: signature,
        evmOrderTypedData: q.evm.orderTypedData,
        evmPermitTypedData: q.evm.permitTypedData || undefined,
        evmPermitSignature: permitSignature,
        meta: {
          pair_id: token?.pair_id,
          token_symbol: token?.token_symbol,
          quote_notional_usd: q.from?.notional,
        },
      });
      setPlaced(res.orderId);
    } catch (err) {
      const msg = isUserRejection(err)
        ? 'Cancelled in wallet'
        : describeApiError(err, (err as Error)?.message || 'Order failed');
      setStep('failed', msg);
    }
  };

  const cancel = async (o: FlashOrder) => {
    if (!address) return;
    setCancelling(o.orderId);
    try {
      const sig = await personalSign(address, cancelMessageFor(o.orderId));
      await cancelOrder(o.orderId, cancelMessageFor(o.orderId), sig);
      await loadOrders();
      if (o.orderId === orderId) setStep('failed', 'Order cancelled');
    } catch (err) {
      setPreviewError(isUserRejection(err) ? 'Cancelled in wallet' : describeApiError(err, 'Cancel failed'));
    } finally {
      setCancelling(null);
    }
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
        return 'Waiting for fill…';
      case 'filled':
        return 'Filled';
      case 'failed':
        return 'Try again';
      default:
        return orderType === 'limit' ? 'Place limit order' : 'Place market order';
    }
  }, [address, wrongNetwork, chainLabel, step, orderType]);

  if (!isOpen || !token) return null;

  const fillTx = fills.find(f => f.transactionId)?.transactionId;
  const stepIndex = STEP_ORDER.findIndex(s => s.key === step);
  const showSteps = stepIndex >= 0 || step === 'filled';

  return (
    <>
      <div className="flash-drawer-backdrop" onClick={closeDrawer} />
      <aside className="flash-drawer" role="dialog" aria-label="Trade with Flash">
        <div className="flash-drawer-header">
          <div>
            <div className="flash-title">⚡ Trade {token.token_symbol ? `$${token.token_symbol}` : ''}</div>
            <div className="flash-sub">Flash by Definitive · {chainLabel} · non-custodial</div>
          </div>
          <button className="flash-close" onClick={closeDrawer} aria-label="Close">
            <CrossIcon color="var(--secondary-text-color-new)" />
          </button>
        </div>

        <div className="flash-tabs">
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
                <span className="flash-wallet-addr">{shortAddress(address)}</span>
                <span className={`flash-wallet-net ${wrongNetwork ? 'wrong' : ''}`}>
                  {wrongNetwork ? `Wrong network` : chainLabel}
                </span>
              </>
            ) : (
              <>
                <span>No wallet connected</span>
                <button
                  className="flash-secondary"
                  style={{ width: 'auto', padding: '4px 10px' }}
                  onClick={() => place()}
                  disabled={busy}>
                  Connect
                </button>
              </>
            )}
          </div>

          {tab === 'trade' && (
            <>
              <div className="flash-tabs" style={{ padding: 0 }}>
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
                <label>You pay</label>
                <div className="flash-input">
                  <input
                    inputMode="decimal"
                    value={amount}
                    disabled={busy}
                    onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="0"
                  />
                  <span className="flash-unit">USDC</span>
                </div>
                <div className="flash-quick">
                  {QUICK_AMOUNTS.map(a => (
                    <button key={a} disabled={busy} onClick={() => setAmount(a)}>
                      ${a}
                    </button>
                  ))}
                </div>
              </div>

              {orderType === 'limit' && (
                <div className="flash-field">
                  <label>Limit price (USD per {token.token_symbol || 'token'}) · buys at or below</label>
                  <div className="flash-input">
                    <input
                      inputMode="decimal"
                      value={limitPrice}
                      disabled={busy}
                      onChange={e => {
                        limitTouched.current = true;
                        setLimitPrice(e.target.value.replace(/[^0-9.eE-]/g, ''));
                      }}
                      placeholder="auto from quote"
                    />
                    <span className="flash-unit">USD</span>
                  </div>
                </div>
              )}

              <div className="flash-summary">
                <div className="row big">
                  <span>You receive</span>
                  <span>
                    {previewLoading && !preview ? '…' : fmt(preview?.to?.amount)} {token.token_symbol || ''}
                  </span>
                </div>
                <div className="row">
                  <span>{orderType === 'limit' ? 'Spot price' : 'Price'}</span>
                  <span>{preview ? `$${fmt(impliedPrice(preview))}` : '–'}</span>
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
                    Fees (Flash + askRoger{' '}
                    {preview?.integratorFeeBps && preview.integratorFeeBps !== '0'
                      ? `${Number(preview.integratorFeeBps) / 100}%`
                      : ''}
                    )
                  </span>
                  <span>
                    {preview?.fees?.estimatedFeeNotional ? `$${fmt(preview.fees.estimatedFeeNotional, 4)}` : '–'}
                  </span>
                </div>
                {previewError && <div className="flash-error">{previewError}</div>}
                {!previewError && (
                  <div className="muted">
                    {orderType === 'limit'
                      ? 'Rests with Flash until price is reached. Gasless execution, cancel any time.'
                      : 'Executes at the best route Flash finds. Flash pays the execution gas.'}
                  </div>
                )}
              </div>

              {showSteps && (
                <div className="flash-steps">
                  {STEP_ORDER.map((s, i) => (
                    <span
                      key={s.key}
                      className={`step ${step === s.key ? 'on' : ''} ${
                        step === 'filled' || (stepIndex > i && stepIndex >= 0) ? 'done' : ''
                      }`}>
                      {s.label}
                    </span>
                  ))}
                </div>
              )}

              {error && <div className="flash-error">{error}</div>}

              {(step === 'placed' || step === 'filled' || (step === 'failed' && orderId)) && (
                <div className="flash-status">
                  <div className="flash-status-title">
                    <span>Order</span>
                    <span className={`pill ${step === 'filled' ? 'ok' : step === 'failed' ? 'bad' : ''}`}>
                      {statusLabel(order?.status) || (step === 'placed' ? 'pending' : step)}
                    </span>
                  </div>
                  <div className="mono">{orderId}</div>
                  {order?.filled?.targetAmount && (
                    <div>
                      Filled {fmt(order.filled.targetAmount)} {token.token_symbol} @ $
                      {fmt(order.filled.averageNotionalPrice || order.filled.averagePrice)}
                    </div>
                  )}
                  {fillTx && explorer && (
                    <a href={`${explorer}${fillTx}`} target="_blank" rel="noopener noreferrer">
                      View fill on explorer ↗
                    </a>
                  )}
                  {!fillTx && txHash && explorer && (
                    <a href={`${explorer}${txHash}`} target="_blank" rel="noopener noreferrer">
                      View approval on explorer ↗
                    </a>
                  )}
                </div>
              )}

              {step === 'placed' || step === 'filled' ? (
                <>
                  <button className="flash-primary" disabled>
                    {primaryLabel}
                  </button>
                  <button
                    className="flash-secondary"
                    onClick={() => {
                      reset();
                      setTxHash(null);
                    }}>
                    New order
                  </button>
                </>
              ) : (
                <button
                  className="flash-primary"
                  disabled={
                    busy || !usdc || (!!address && !wrongNetwork && (!preview || !!previewError) && step !== 'failed')
                  }
                  onClick={() => (step === 'failed' ? (reset(), place()) : place())}>
                  {primaryLabel}
                </button>
              )}
            </>
          )}

          {tab === 'orders' && (
            <div className="flash-orders">
              {!address && <div className="empty">Connect a wallet to see its Flash orders.</div>}
              {address && ordersLoading && <div className="empty">Loading…</div>}
              {address && !ordersLoading && orders.length === 0 && (
                <div className="empty">No Flash orders for this token from {shortAddress(address)}.</div>
              )}
              {previewError && tab === 'orders' && <div className="flash-error">{previewError}</div>}
              {orders.map(o => {
                const open = !TERMINAL_STATUSES.has(o.status);
                return (
                  <div className="flash-order" key={o.orderId}>
                    <div className="top">
                      <span>
                        {o.side} {o.orderType} · {fmt(o.qty)} {o.side === 'buy' ? 'USDC' : o.targetAsset?.ticker || ''}
                      </span>
                      <span className={`pill ${o.status === 'ORDER_STATUS_FILLED' ? 'ok' : open ? '' : 'bad'}`}>
                        {statusLabel(o.status)}
                      </span>
                    </div>
                    <div className="meta">
                      {o.limitNotionalPrice ? `limit $${fmt(o.limitNotionalPrice)} · ` : ''}
                      {o.filled?.averageNotionalPrice ? `avg $${fmt(o.filled.averageNotionalPrice)} · ` : ''}
                      {o.placedAt ? new Date(o.placedAt).toLocaleString() : ''}
                    </div>
                    {open && (
                      <div>
                        <button className="cancel" disabled={cancelling === o.orderId} onClick={() => cancel(o)}>
                          {cancelling === o.orderId ? 'Cancelling…' : 'Cancel'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {address && (
                <button className="flash-secondary" onClick={loadOrders} disabled={ordersLoading}>
                  Refresh
                </button>
              )}
            </div>
          )}

          <div className="flash-foot">
            Powered by{' '}
            <a href="https://flash.definitive.fi/docs" target="_blank" rel="noopener noreferrer">
              Definitive Flash
            </a>
            . Your tokens stay in your wallet until the order executes.
          </div>
        </div>
      </aside>
    </>
  );
};

export default TradeDrawer;
