/** Webapp → Flask `/trade/*` calls. The Flask proxy holds the Flash API key. */
import { apiClientNew } from '@lib/api';

export type OrderType = 'market' | 'limit';
export type Side = 'buy' | 'sell';

export interface QuoteRequest {
  targetChain: string;
  contraChain: string;
  targetAsset: string;
  contraAsset: string;
  side: Side;
  qty: string;
  orderType: OrderType;
  funderAddress: string;
  limitNotionalPrice?: string;
  maxSlippage?: string;
  expireTime?: string;
}

export interface QuoteLeg {
  asset: 'target' | 'contra';
  amount: string;
  notional: string;
}

export interface QuoteResponse {
  quoteId: string;
  orderType: OrderType;
  side: Side;
  from: QuoteLeg;
  to: QuoteLeg;
  fees?: { estimatedFeeNotional?: string };
  estimatedPriceImpact?: string;
  recommendedSlippage?: string;
  wrap?: { evmTx?: { to: string; data: string; value?: string } | null } | null;
  evm?: {
    approveTx?: { to: string; data: string } | null;
    permitTypedData?: string | null;
    orderTypedData?: string | null;
  } | null;
  integratorFeeBps?: string;
}

export interface OrderRequest extends QuoteRequest {
  quoteId: string;
  userSignature: string;
  evmOrderTypedData?: string;
  evmPermitTypedData?: string;
  evmPermitSignature?: string;
  meta?: { pair_id?: string; token_symbol?: string; quote_notional_usd?: string };
}

export interface FlashAssetRef {
  id?: string;
  name?: string;
  address: string;
  ticker?: string;
  chain: string;
}

export interface FlashOrder {
  orderId: string;
  orderType: string;
  side: Side;
  status: string;
  closeReason?: string | null;
  funderAddress: string;
  targetAsset: FlashAssetRef;
  contraAsset: FlashAssetRef;
  qty: string;
  filled?: {
    targetAmount?: string;
    contraAmount?: string;
    averagePrice?: string;
    averageNotionalPrice?: string;
  } | null;
  limitNotionalPrice?: string | null;
  placedAt?: string;
  acceptedAt?: string;
  closedAt?: string | null;
}

export interface FlashFill {
  status?: string;
  notional?: string;
  transactionId?: string;
  fillPrice?: string;
  filledAt?: string;
  targetAmount?: string;
  contraAmount?: string;
}

export interface FlashApiError {
  error?: { code?: string; message?: string };
}

export interface TradeStatus {
  enabled: boolean;
  integratorFeeBps: string;
  orderTypes: OrderType[];
  chains: string[];
}

export interface TokenOrdersSummary {
  count: number;
  traders: number;
  recent: { orderType: string; side: Side; funder: string; status: string; placedAt: string }[];
}

export const TERMINAL_STATUSES = new Set([
  'ORDER_STATUS_FILLED',
  'ORDER_STATUS_CANCELLED',
  'ORDER_STATUS_REJECTED',
  'ORDER_STATUS_TERMINATED',
]);

export const getTradeStatus = async (): Promise<TradeStatus> => (await apiClientNew.get('trade/status')).data;

export const postQuote = async (body: QuoteRequest): Promise<QuoteResponse> =>
  (await apiClientNew.post('trade/quote', body)).data;

export const postOrder = async (body: OrderRequest): Promise<{ orderId: string }> =>
  (await apiClientNew.post('trade/order', body)).data;

export const getOrders = async (funderAddress: string, statuses?: string): Promise<{ orders: FlashOrder[] }> =>
  (await apiClientNew.get('trade/orders', { params: { funderAddress, statuses, pageSize: 50 } })).data;

export const getOrder = async (
  orderId: string,
  funderAddress: string,
): Promise<{ order: FlashOrder; fills: FlashFill[] }> =>
  (await apiClientNew.get(`trade/orders/${orderId}`, { params: { funderAddress } })).data;

export const cancelOrder = async (
  orderId: string,
  cancelMessage: string,
  userSignature: string,
): Promise<{ ok: boolean }> =>
  (await apiClientNew.post(`trade/orders/${orderId}/cancel`, { cancelMessage, userSignature })).data;

export const getTokenOrdersSummary = async (chain: string, tokenId: string): Promise<TokenOrdersSummary> =>
  (await apiClientNew.get(`trade/token/${chain}/${tokenId}/orders`)).data;

/** Flash's cancel message format (em dash, single newline). Signed with personal_sign. */
export const cancelMessageFor = (orderId: string): string => `Definitive Flash v1 — Cancel Order\nOrder: ${orderId}`;

/** Pull Flash's human message out of an axios error, else a generic one. */
type ApiErrorBody = { error?: { code?: string; message?: string } | string };
export const describeApiError = (err: unknown, fallback = 'Request failed'): string => {
  const e = err as { response?: { status?: number; data?: ApiErrorBody }; message?: string };
  const body = e?.response?.data?.error;
  if (body && typeof body === 'object') return body.message || body.code || fallback;
  if (typeof body === 'string') return body;
  if (e?.response?.status === 429) return 'Too many requests, wait a second and retry';
  if (e?.response?.status === 401) return 'Log in to trade';
  return e?.message || fallback;
};
