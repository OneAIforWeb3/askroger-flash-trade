/**
 * Minimal injected-wallet helper (window.ethereum, EIP-1193). No SDK: Flash hands us
 * the exact transaction to send and the exact EIP-712 payload to sign, so raw
 * JSON-RPC is all the drawer needs. Same pattern as WaitlistDashboard/AccountInfo.
 */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
};

export class WalletError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

const USER_REJECTED = 4001;

// Another module already declares window.ethereum with a narrower type; cast instead of re-declaring.
export const getProvider = (): Eip1193Provider | null =>
  (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;

const rpcError = (err: unknown, fallback: string): WalletError => {
  const e = err as { code?: number; message?: string; data?: { message?: string } };
  if (e?.code === USER_REJECTED) return new WalletError('You rejected the request in your wallet', USER_REJECTED);
  return new WalletError(e?.data?.message || e?.message || fallback, e?.code);
};

export const isUserRejection = (err: unknown): boolean => (err as WalletError)?.code === USER_REJECTED;

export async function connect(): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new WalletError('No browser wallet found. Install MetaMask or another EVM wallet.');
  try {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accounts?.length) throw new WalletError('Wallet returned no accounts');
    return accounts[0];
  } catch (err) {
    throw rpcError(err, 'Could not connect wallet');
  }
}

export async function getChainId(): Promise<number> {
  const provider = getProvider();
  if (!provider) throw new WalletError('No browser wallet found');
  const hex = (await provider.request({ method: 'eth_chainId' })) as string;
  return parseInt(hex, 16);
}

export async function switchChain(chainId: number): Promise<void> {
  const provider = getProvider();
  if (!provider) throw new WalletError('No browser wallet found');
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
  } catch (err) {
    const e = err as { code?: number };
    if (e?.code === 4902)
      throw new WalletError(`Your wallet does not know chain ${chainId}. Add it in the wallet first.`);
    throw rpcError(err, 'Could not switch network');
  }
}

export async function sendTransaction(tx: {
  from: string;
  to: string;
  data?: string;
  value?: string;
}): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new WalletError('No browser wallet found');
  try {
    return (await provider.request({ method: 'eth_sendTransaction', params: [tx] })) as string;
  } catch (err) {
    throw rpcError(err, 'Transaction was not sent');
  }
}

/**
 * Flash serializes `domain.chainId` as a string. Wallets compare it against the active
 * chain and some libraries drop a string chainId from the domain hash (Definitive's own
 * reference client coerces it), so hand the wallet a number. `types.EIP712Domain` is
 * present in Flash's payload and eth_signTypedData_v4 requires it, so it is kept.
 */
export const normalizeTypedData = (typedDataJson: string): string => {
  const td = JSON.parse(typedDataJson) as { domain?: { chainId?: string | number } };
  if (td?.domain?.chainId !== undefined && td.domain.chainId !== null) {
    td.domain.chainId = Number(td.domain.chainId);
  }
  return JSON.stringify(td);
};

/** Flash returns `orderTypedData` as a JSON string; eth_signTypedData_v4 takes that string. */
export async function signTypedDataV4(address: string, typedDataJson: string): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new WalletError('No browser wallet found');
  try {
    return (await provider.request({
      method: 'eth_signTypedData_v4',
      params: [address, normalizeTypedData(typedDataJson)],
    })) as string;
  } catch (err) {
    throw rpcError(err, 'Order was not signed');
  }
}

/** EIP-191 personal_sign, used for Flash cancel messages. */
export async function personalSign(address: string, message: string): Promise<string> {
  const provider = getProvider();
  if (!provider) throw new WalletError('No browser wallet found');
  const hex = `0x${Array.from(new TextEncoder().encode(message))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`;
  try {
    return (await provider.request({ method: 'personal_sign', params: [hex, address] })) as string;
  } catch (err) {
    throw rpcError(err, 'Message was not signed');
  }
}

export async function waitForReceipt(txHash: string, timeoutMs = 120_000): Promise<{ status: string }> {
  const provider = getProvider();
  if (!provider) throw new WalletError('No browser wallet found');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = (await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] })) as {
      status?: string;
    } | null;
    if (receipt?.status) {
      if (receipt.status === '0x0') throw new WalletError('Transaction reverted onchain');
      return { status: receipt.status };
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new WalletError('Timed out waiting for the transaction to confirm');
}

export const shortAddress = (addr?: string | null): string =>
  addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr || '';

/** ERC-20 balanceOf via eth_call, decoded to a decimal string. Returns null on any failure. */
export async function getErc20Balance(token: string, owner: string, decimals: number): Promise<string | null> {
  const provider = getProvider();
  if (!provider) return null;
  try {
    const data = `0x70a08231${owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
    const hex = (await provider.request({ method: 'eth_call', params: [{ to: token, data }, 'latest'] })) as string;
    const raw = BigInt(hex || '0x0');
    const base = BigInt(10) ** BigInt(decimals);
    const whole = raw / base;
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return null;
  }
}
