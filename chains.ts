/**
 * Chain facts for the Flash (Definitive) trade drawer.
 * Flash's `Chain` enum (openapi.json, 2026-11-05) and the EVM chain ids we need
 * for wallet_switchEthereumChain. v1 buys with USDC only, so a chain is tradable
 * only when its USDC address is known and verified.
 */
export const FLASH_CHAINS = [
  'arbitrum',
  'avalanche',
  'base',
  'bsc',
  'ethereum',
  'optimism',
  'polygon',
  'solana',
  'hyperevm',
  'plasma',
  'monad',
  'robinhood',
  'ink',
  'arc',
] as const;
export type FlashChain = (typeof FLASH_CHAINS)[number];

/** Our leaderboard slugs that differ from Flash's. */
const CHAIN_ALIASES: Record<string, FlashChain> = { binance: 'bsc', bnb: 'bsc' };

export const normalizeChain = (chain?: string | null): FlashChain | null => {
  const slug = (chain || '').trim().toLowerCase();
  const mapped = (CHAIN_ALIASES[slug] || slug) as FlashChain;
  return (FLASH_CHAINS as readonly string[]).includes(mapped) ? mapped : null;
};

export const EVM_CHAIN_IDS: Partial<Record<FlashChain, number>> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  avalanche: 43114,
  bsc: 56,
  optimism: 10,
  polygon: 137,
  hyperevm: 999,
  robinhood: 4663,
  arc: 5042,
  ink: 57073,
  plasma: 9745,
  monad: 143,
};

/** Contra asset per chain. From the Flash docs (Base, Arbitrum); add others only after
 * verifying the address with GET /trade/search or a block explorer. */
export const USDC_BY_CHAIN: Partial<Record<FlashChain, { address: string; decimals: number }>> = {
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  arbitrum: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
};

export const EXPLORER_TX_BY_CHAIN: Partial<Record<FlashChain, string>> = {
  ethereum: 'https://etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  polygon: 'https://polygonscan.com/tx/',
};

export const CHAIN_LABELS: Partial<Record<FlashChain, string>> = {
  base: 'Base',
  arbitrum: 'Arbitrum',
  ethereum: 'Ethereum',
  bsc: 'BNB Chain',
  optimism: 'Optimism',
  avalanche: 'Avalanche',
  polygon: 'Polygon',
};

/** A token row can open the Flash drawer when its chain is EVM, known to Flash, and has a USDC address. */
export const isFlashTradable = (chain?: string | null, isCoin?: number | boolean | null): boolean => {
  if (isCoin) return false;
  const c = normalizeChain(chain);
  return !!c && c !== 'solana' && !!EVM_CHAIN_IDS[c] && !!USDC_BY_CHAIN[c];
};
