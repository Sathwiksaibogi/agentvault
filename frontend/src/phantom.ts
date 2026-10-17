import type { PublicKey, Transaction } from "@solana/web3.js";

export interface WalletPublicKey {
  toBase58(): string;
}

export interface PhantomProvider {
  isPhantom?: boolean;

  publicKey: PublicKey | null;

  connect(): Promise<{
    publicKey: WalletPublicKey;
  }>;

  disconnect(): Promise<void>;

  signTransaction(transaction: Transaction): Promise<Transaction>;
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
