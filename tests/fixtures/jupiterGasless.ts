/**
 * Two REAL mainnet transaction shapes for a gasless USDC -> SOL swap, as
 * Jupiter's Swap API returns them for signing. Taken from public mainnet
 * transactions on 2 October 2026 (read-only RPC; see
 * docs/gasless-sol-topup.md §4) with every signature zeroed and the swapper's
 * identity replaced by a synthetic one:
 *
 *   owner      = the BIP-39 test phrase "abandon … about" at m/44'/501'/0'/0'
 *                (HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk) — public test data, never a real wallet;
 *   ownerUsdc / ownerWsol = that owner's canonical USDC / WSOL accounts.
 *
 * Everything else — instruction order, data bytes, programs, Jupiter's gas
 * wallet, the market maker, the lookup tables — is the original.
 *
 * METIS: Jupiter-sponsored (fee payer gasTzr…), route_v2, 12.540807 USDC in,
 *   source 42AfmdyYPyVzo6fW2e4q4GpemmJyBmau5CTCpkZBwB7WCySSj2bHegjXc5eewVdWaFhUuY6NVGExyr9LnHhYTBvd
 *   (slot 452742498). The swapper received 106,119,149 lamports.
 * RFQ: JupiterZ fill paid by the market maker, 0.543057 USDC in,
 *   source ZdufciaFaD4d92EC1PGPf5c3TzkzRLBEcZLqGiNcYZweWNQgaTnuZ3gZRGj1dvxxeSNrMUhvbvsRYHE1zgtCfAT
 *   (slot 452743537). The swapper received 4,592,968 lamports.
 *
 * The order fields below are RECONSTRUCTED from each transaction's own
 * instruction data (Jupiter's /order response for them was not captured).
 */

export const OWNER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
export const OWNER_USDC = "5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt";
export const OWNER_WSOL = "CJoNbVgQcSsTHuTza6CSYoSuojo2vDMN3mxzM1GcTPSF";
export const TEST_PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

export const METIS = {
  unsignedBase64:
  "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAIABQoKI/LW57XKxPlrnBnjR8pw" +
  "JqlB8IMXoWShoopBSd7LSPA2J2JGp1ud4zSe1CsV4jL2UY/CD1/NTx1k6B+b0lj3iODf8VvwBTKUkIJ/Y9Eif0dqphZhHVI9k4/9" +
  "JFpM34On/90BBnpik/KR8QwNjg/a6SNBG1AeiRuWANppcU+NcEDS8nxGHynp/roauKzTlJapxlsK5ipxPwH5QamTv1XtAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WQMGRm/lIRcy/+ytunLDm+e8" +
  "jOW7xfcSayxDmzpAAAAABHnVW/IxwG7udMVuzmgVB/2xst6j9I5RArHNola8E48G3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWF" +
  "fv8AqRXMJl/vSiTLZMuHVKmXVpRLEuUTtd8T4WH3IKgpkT0SBgcABQJ3jQEABwAJA/+eAAAAAAAABgYAAwEQBQkBAQgYAQQDDhAJ" +
  "CQgNCAIRAQsMCgMECQkTEggPKLtk+swxxK8Uh1u/AAAAAAA/ilMGAAAAACIACwAAAAEAAACNABAnAAEJAwMBAQEJBQIBAAwCAAAA" +
  "OLYWAAAAAAACKb+VBypPvwTfcXWT5zi8zCEnKBXCRxqA2fn1VbDUhCUABAAoARdqqcPrNb0kOj4f4oBo3tqeUfk5BcRkq+duwyJj" +
  "by342QOAhYQDgod/",
  blockTime: 1790979540,
  inAmount: 12_540_807n,
  /** quoted_out 106,138,175 less the route's 11 bps fee. */
  outAmount: 106_021_423n,
  feeBps: 11,
  feePayer: "gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB",
  /** Lookup-table contents at the indexes this transaction loads. */
  tables: {
  "3oy9ojnsDzqmMNi87Gs7Hn5v3MPVqnWjG9k8BmzKR7yW": {
    "0": "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
    "1": "jitodontfront11111111111JustUseJupiterU1tra",
    "23": "So11111111111111111111111111111111111111112",
    "40": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  },
  "8BNMiq1CM4g3zZbhbWQHn27631FPAJLGMF2c52y3Vs5i": {
    "127": "Sysvar1nstructions1111111111111111111111111",
    "128": "2Y7HATmn9aJBcxCskE5V2U2epmjvkZmB51zTJBbhj4cU",
    "130": "BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi",
    "132": "ATRsNGv2nDw7hSMfkUTBoVUDsFDwN7po7KbecyiGWNB4",
    "133": "8FnX3xo2yYw3EUE6w3nQA4GfXGS9wpK6oj3veJpbFzLo",
    "135": "J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv"
  }
} as Record<string, Record<string, string>>,
};

export const RFQ = {
  unsignedBase64:
  "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAIABg1l4eWU9W+LbzHkYy5erq32" +
  "+K0Kp0kwgKUELcMBr/mwIfA2J2JGp1ud4zSe1CsV4jL2UY/CD1/NTx1k6B+b0lj3CaG3UKbDgJznjNXjNbmUyiwUZ6yLBqOxiJwn" +
  "z/wBDQhwMIoK5lD0f8OUQD7+I20js7jTCATSPJ/yV+rcGGj34Ijg3/Fb8AUylJCCf2PRIn9HaqYWYR1SPZOP/SRaTN+DmSb6l/rN" +
  "0Xfh+NsexPDFly2ez3JXxMpRSb8q/WeKC71A0vJ8Rh8p6f66Gris05SWqcZbCuYqcT8B+UGpk79V7QAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAA" +
  "AAAAAQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpSlhJ+3Kju+kf3FsOalf2PFoctFsgZ6btDKzTY5XIoQLG+nrzvtut" +
  "Oj1l82qryXQxsbvkwtL24OR8pgIDRS9dYV8P00lGm9SyVMA045BoMbKugYy4cY4lwQ/FUwuVvGAwBQgACQMVDQAAAAAAAAgABQLt" +
  "YQAACwwBAAYDCwUMCgkKBwIlqGC3o1wKKKBRSQgAAAAAAD0nRgAAAAAAHi/AagAAAAAAAAIKAAcCAQQMAgAAAPURAAAAAAAACgEE" +
  "AREA",
  blockTime: 1790979820,
  inAmount: 543_057n,
  /** The fill's 4,597,565 lamports less the 4,597-lamport (10 bps) fee transfer. */
  outAmount: 4_592_968n,
  feeBps: 10,
  feePayer: "7rhxnLV8C77o6d8oz26AgK8x8m5ePsdeRawjqvojbjnQ",
};
