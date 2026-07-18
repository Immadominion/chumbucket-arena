/**
 * The real Walrus Memory transport — wraps the official `@mysten-incubation/memwal`
 * SDK behind our MemWalClient port. Auth is a single Ed25519 *delegate key* the
 * product holds (no owner wallet at runtime); the relayer (a TEE) does the
 * encryption, embedding, and Walrus storage server-side. Provision the delegate
 * key once with scripts/memwal-setup.ts, then set MEMWAL_PRIVATE_KEY + ACCOUNT_ID.
 *
 * Writes are fire-and-accept (the relayer finishes embedding/uploading in the
 * background) so the command path is never blocked on Walrus; recall is a
 * semantic search returning decrypted plaintext.
 */
import type { MemWalClient, MemWalRecallHit } from "./MemWalClient";
export interface SdkMemWalConfig {
    privateKey: string;
    accountId: string;
    serverUrl?: string;
}
export declare class SdkMemWalClient implements MemWalClient {
    private readonly mw;
    constructor(cfg: SdkMemWalConfig);
    remember(namespace: string, text: string): Promise<void>;
    recall(namespace: string, query: string, limit: number): Promise<MemWalRecallHit[]>;
    restore(namespace: string, limit: number): Promise<{
        count: number;
    }>;
}
