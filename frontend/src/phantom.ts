export interface WalletPublicKey {
  toBase58(): string;
}

export interface PhantomProvider {
  isPhantom?: boolean;

  connect(): Promise<{
    publicKey: WalletPublicKey;
  }>;

  disconnect(): Promise<void>;
}

declare global {
  interface Window {
    phantom?: {
      solana?: PhantomProvider;
    };

    solana?: PhantomProvider;
  }
}

export function getPhantomProvider(): PhantomProvider | null {
  const provider = window.phantom?.solana ?? window.solana;

  if (!provider?.isPhantom) {
    return null;
  }

  return provider;
}
