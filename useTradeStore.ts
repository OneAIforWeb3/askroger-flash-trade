import { create } from 'zustand';
import { TokenDataItem } from '@customTypes/cashtag.types';
import { FlashFill, FlashOrder, QuoteResponse } from './trade.service';

export type TradeStep =
  | 'idle'
  | 'connecting'
  | 'switching'
  | 'quoting'
  | 'approving'
  | 'signing'
  | 'submitting'
  | 'placed'
  | 'filled'
  | 'failed';

interface TradeState {
  isOpen: boolean;
  token: TokenDataItem | null;
  address: string | null;
  chainId: number | null;
  step: TradeStep;
  error: string | null;
  quote: QuoteResponse | null;
  orderId: string | null;
  order: FlashOrder | null;
  fills: FlashFill[];
  openDrawer: (token: TokenDataItem) => void;
  closeDrawer: () => void;
  setWallet: (address: string | null, chainId: number | null) => void;
  setStep: (step: TradeStep, error?: string | null) => void;
  setQuote: (quote: QuoteResponse | null) => void;
  setPlaced: (orderId: string) => void;
  setOrderState: (order: FlashOrder | null, fills: FlashFill[]) => void;
  reset: () => void;
}

const fresh = { step: 'idle' as TradeStep, error: null, quote: null, orderId: null, order: null, fills: [] };

export const useTradeStore = create<TradeState>()(set => ({
  isOpen: false,
  token: null,
  address: null,
  chainId: null,
  ...fresh,
  openDrawer: token => set({ isOpen: true, token, ...fresh }),
  closeDrawer: () => set({ isOpen: false }),
  setWallet: (address, chainId) => set({ address, chainId }),
  setStep: (step, error = null) => set({ step, error }),
  setQuote: quote => set({ quote }),
  setPlaced: orderId => set({ orderId, step: 'placed', error: null }),
  setOrderState: (order, fills) => set({ order, fills }),
  reset: () => set({ ...fresh }),
}));
