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

/** Contra asset per chain: the native (Circle) USDC that Flash's GET /search returns as
 * plain "USDC" on each chain, re-checked with a live /quote on 2026-11-11. Bridged USDC.e
 * variants are deliberately not used. BSC only has Binance-Peg USDC, which is 18 decimals. */
export const USDC_BY_CHAIN: Partial<Record<FlashChain, { address: string; decimals: number }>> = {
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  arbitrum: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  ethereum: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  optimism: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
  polygon: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  avalanche: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
  bsc: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
};

/** What wallet_addEthereumChain needs when the user's wallet has never seen the chain (EIP-3085).
 * Public RPCs only; the wallet replaces them with its own once the chain is added. */
export type AddChainParams = {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
};
const hex = (id: number) => `0x${id.toString(16)}`;
export const WALLET_CHAIN_PARAMS: Partial<Record<FlashChain, AddChainParams>> = {
  ethereum: {
    chainId: hex(1),
    chainName: 'Ethereum Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-rpc.publicnode.com'],
    blockExplorerUrls: ['https://etherscan.io'],
  },
  base: {
    chainId: hex(8453),
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  },
  arbitrum: {
    chainId: hex(42161),
    chainName: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    blockExplorerUrls: ['https://arbiscan.io'],
  },
  optimism: {
    chainId: hex(10),
    chainName: 'OP Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.optimism.io'],
    blockExplorerUrls: ['https://optimistic.etherscan.io'],
  },
  polygon: {
    chainId: hex(137),
    chainName: 'Polygon Mainnet',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://polygon-rpc.com'],
    blockExplorerUrls: ['https://polygonscan.com'],
  },
  avalanche: {
    chainId: hex(43114),
    chainName: 'Avalanche C-Chain',
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'],
    blockExplorerUrls: ['https://snowtrace.io'],
  },
  bsc: {
    chainId: hex(56),
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.binance.org'],
    blockExplorerUrls: ['https://bscscan.com'],
  },
};

/** Native token the user needs for gas on each chain, for the drawer's hint copy. */
export const GAS_SYMBOL_BY_CHAIN: Partial<Record<FlashChain, string>> = {
  ethereum: 'ETH',
  base: 'ETH',
  arbitrum: 'ETH',
  optimism: 'ETH',
  polygon: 'POL',
  avalanche: 'AVAX',
  bsc: 'BNB',
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
