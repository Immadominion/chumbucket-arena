/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/chumbucket_arena.json`.
 */
export type ChumbucketArena = {
    "address": "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG";
    "metadata": {
        "name": "gafferVerifier";
        "version": "0.1.0";
        "spec": "0.1.0";
        "description": "Created with Anchor";
    };
    "instructions": [
        {
            "name": "claim";
            "docs": [
                "Pull your own payout (or refund on a void). Closes the position."
            ];
            "discriminator": [
                62,
                198,
                214,
                193,
                213,
                159,
                108,
                210
            ];
            "accounts": [
                {
                    "name": "player";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "pot";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot.match_id";
                                "account": "pot";
                            }
                        ];
                    };
                },
                {
                    "name": "vault";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    118,
                                    97,
                                    117,
                                    108,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot";
                            }
                        ];
                    };
                },
                {
                    "name": "playerUsdc";
                    "writable": true;
                },
                {
                    "name": "position";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    115,
                                    105,
                                    116,
                                    105,
                                    111,
                                    110
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot";
                            },
                            {
                                "kind": "account";
                                "path": "player";
                            }
                        ];
                    };
                },
                {
                    "name": "tokenProgram";
                    "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
                }
            ];
            "args": [];
        },
        {
            "name": "createPot";
            "docs": [
                "Open a match's parimutuel Pot and its USDC vault."
            ];
            "discriminator": [
                232,
                45,
                123,
                181,
                204,
                121,
                131,
                9
            ];
            "accounts": [
                {
                    "name": "keeper";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "config";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "pot";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    116
                                ];
                            },
                            {
                                "kind": "arg";
                                "path": "matchId";
                            }
                        ];
                    };
                },
                {
                    "name": "vault";
                    "docs": [
                        "The USDC vault — a token account owned by the Pot PDA. Funds only leave",
                        "via `claim`, signed by the Pot's own seeds after settlement."
                    ];
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    118,
                                    97,
                                    117,
                                    108,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot";
                            }
                        ];
                    };
                },
                {
                    "name": "usdcMint";
                },
                {
                    "name": "tokenProgram";
                    "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                },
                {
                    "name": "rent";
                    "address": "SysvarRent111111111111111111111111111111111";
                }
            ];
            "args": [
                {
                    "name": "matchId";
                    "type": {
                        "array": [
                            "u8",
                            32
                        ];
                    };
                },
                {
                    "name": "txlineFixtureId";
                    "type": "i64";
                },
                {
                    "name": "kickoff";
                    "type": "i64";
                }
            ];
        },
        {
            "name": "initConfig";
            "docs": [
                "One-time: pin the USDC mint + txoracle program, set rake + thin-pool floor."
            ];
            "discriminator": [
                23,
                235,
                115,
                232,
                168,
                96,
                1,
                231
            ];
            "accounts": [
                {
                    "name": "admin";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "config";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "usdcMint";
                },
                {
                    "name": "txoracleProgram";
                    "docs": [
                        "verifies the passed txoracle program matches this address."
                    ];
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                }
            ];
            "args": [
                {
                    "name": "rakeBps";
                    "type": "u16";
                },
                {
                    "name": "minParticipants";
                    "type": "u8";
                }
            ];
        },
        {
            "name": "lockPot";
            "docs": [
                "Freeze calls at kickoff (permissionless)."
            ];
            "discriminator": [
                251,
                183,
                190,
                181,
                243,
                124,
                242,
                188
            ];
            "accounts": [
                {
                    "name": "pot";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot.match_id";
                                "account": "pot";
                            }
                        ];
                    };
                }
            ];
            "args": [];
        },
        {
            "name": "placeCall";
            "docs": [
                "Stake USDC on an outcome — funds move into the vault now."
            ];
            "discriminator": [
                11,
                8,
                17,
                8,
                195,
                166,
                211,
                69
            ];
            "accounts": [
                {
                    "name": "player";
                    "writable": true;
                    "signer": true;
                },
                {
                    "name": "pot";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot.match_id";
                                "account": "pot";
                            }
                        ];
                    };
                },
                {
                    "name": "vault";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    118,
                                    97,
                                    117,
                                    108,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot";
                            }
                        ];
                    };
                },
                {
                    "name": "playerUsdc";
                    "writable": true;
                },
                {
                    "name": "position";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    115,
                                    105,
                                    116,
                                    105,
                                    111,
                                    110
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot";
                            },
                            {
                                "kind": "account";
                                "path": "player";
                            }
                        ];
                    };
                },
                {
                    "name": "tokenProgram";
                    "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
                },
                {
                    "name": "systemProgram";
                    "address": "11111111111111111111111111111111";
                }
            ];
            "args": [
                {
                    "name": "bucket";
                    "type": "u8";
                },
                {
                    "name": "amount";
                    "type": "u64";
                }
            ];
        },
        {
            "name": "settlePot";
            "docs": [
                "Settle by proving the outcome on-chain via a `validate_stat` CPI."
            ];
            "discriminator": [
                120,
                181,
                232,
                100,
                60,
                57,
                32,
                238
            ];
            "accounts": [
                {
                    "name": "config";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "pot";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot.match_id";
                                "account": "pot";
                            }
                        ];
                    };
                },
                {
                    "name": "txoracleProgram";
                },
                {
                    "name": "dailyScoresMerkleRoots";
                    "docs": [
                        "for `ts`'s epoch day (require_keys_eq against the derived address)."
                    ];
                }
            ];
            "args": [
                {
                    "name": "winningBucket";
                    "type": "u8";
                },
                {
                    "name": "ts";
                    "type": "i64";
                },
                {
                    "name": "fixtureSummary";
                    "type": {
                        "defined": {
                            "name": "scoresBatchSummary";
                        };
                    };
                },
                {
                    "name": "fixtureProof";
                    "type": {
                        "vec": {
                            "defined": {
                                "name": "proofNode";
                            };
                        };
                    };
                },
                {
                    "name": "mainTreeProof";
                    "type": {
                        "vec": {
                            "defined": {
                                "name": "proofNode";
                            };
                        };
                    };
                },
                {
                    "name": "statHome";
                    "type": {
                        "defined": {
                            "name": "statTerm";
                        };
                    };
                },
                {
                    "name": "statAway";
                    "type": {
                        "defined": {
                            "name": "statTerm";
                        };
                    };
                }
            ];
        },
        {
            "name": "sweepRake";
            "docs": [
                "Sweep a settled pot's accrued house rake out to the manager treasury",
                "(admin-only; can never touch a winner's unclaimed payout)."
            ];
            "discriminator": [
                8,
                64,
                18,
                95,
                96,
                177,
                71,
                195
            ];
            "accounts": [
                {
                    "name": "keeper";
                    "docs": [
                        "The config admin (the keeper the backend runs) — the only signer allowed",
                        "to move house revenue."
                    ];
                    "signer": true;
                },
                {
                    "name": "config";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "pot";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot.match_id";
                                "account": "pot";
                            }
                        ];
                    };
                },
                {
                    "name": "vault";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    118,
                                    97,
                                    117,
                                    108,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot";
                            }
                        ];
                    };
                },
                {
                    "name": "managerUsdc";
                    "docs": [
                        "The house treasury USDC account the rake is swept to. Must hold the",
                        "config's USDC mint, and must not be the vault itself (a self-transfer",
                        "would silently break the vault.amount + paid_out == total_stake ledger).",
                        "The admin chooses which account — they own the house revenue."
                    ];
                    "writable": true;
                },
                {
                    "name": "tokenProgram";
                    "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
                }
            ];
            "args": [];
        },
        {
            "name": "verifyMatchStat";
            "docs": [
                "Standalone read-only proof check (client-side \"verify it yourself\" helper)."
            ];
            "discriminator": [
                21,
                202,
                165,
                190,
                110,
                9,
                111,
                149
            ];
            "accounts": [
                {
                    "name": "txoracleProgram";
                    "docs": [
                        "program id below, so no further validation of its contents is needed."
                    ];
                    "address": "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA";
                },
                {
                    "name": "dailyScoresMerkleRoots";
                    "docs": [
                        "this stat. txoracle's own handler validates this account's",
                        "owner/PDA derivation internally — we pass it through untouched as the",
                        "CPI account, so this program does no independent validation of it."
                    ];
                }
            ];
            "args": [
                {
                    "name": "ts";
                    "type": "i64";
                },
                {
                    "name": "fixtureSummary";
                    "type": {
                        "defined": {
                            "name": "scoresBatchSummary";
                        };
                    };
                },
                {
                    "name": "fixtureProof";
                    "type": {
                        "vec": {
                            "defined": {
                                "name": "proofNode";
                            };
                        };
                    };
                },
                {
                    "name": "mainTreeProof";
                    "type": {
                        "vec": {
                            "defined": {
                                "name": "proofNode";
                            };
                        };
                    };
                },
                {
                    "name": "predicate";
                    "type": {
                        "defined": {
                            "name": "traderPredicate";
                        };
                    };
                },
                {
                    "name": "statHome";
                    "type": {
                        "defined": {
                            "name": "statTerm";
                        };
                    };
                },
                {
                    "name": "statAway";
                    "type": {
                        "defined": {
                            "name": "statTerm";
                        };
                    };
                },
                {
                    "name": "op";
                    "type": {
                        "defined": {
                            "name": "binaryExpression";
                        };
                    };
                }
            ];
            "returns": "bool";
        },
        {
            "name": "voidPot";
            "docs": [
                "Rescue: void a stuck locked pot (admin any time; anyone after timeout)."
            ];
            "discriminator": [
                30,
                99,
                197,
                190,
                2,
                36,
                139,
                100
            ];
            "accounts": [
                {
                    "name": "caller";
                    "signer": true;
                },
                {
                    "name": "config";
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    99,
                                    111,
                                    110,
                                    102,
                                    105,
                                    103
                                ];
                            }
                        ];
                    };
                },
                {
                    "name": "pot";
                    "writable": true;
                    "pda": {
                        "seeds": [
                            {
                                "kind": "const";
                                "value": [
                                    112,
                                    111,
                                    116
                                ];
                            },
                            {
                                "kind": "account";
                                "path": "pot.match_id";
                                "account": "pot";
                            }
                        ];
                    };
                }
            ];
            "args": [];
        }
    ];
    "accounts": [
        {
            "name": "config";
            "discriminator": [
                155,
                12,
                170,
                224,
                30,
                250,
                204,
                130
            ];
        },
        {
            "name": "position";
            "discriminator": [
                170,
                188,
                143,
                228,
                122,
                64,
                247,
                208
            ];
        },
        {
            "name": "pot";
            "discriminator": [
                238,
                118,
                60,
                175,
                178,
                191,
                59,
                58
            ];
        }
    ];
    "errors": [
        {
            "code": 6000;
            "name": "missingTxlineReturnData";
            "msg": "txoracle CPI did not return the expected bool return-data";
        },
        {
            "code": 6001;
            "name": "rakeTooHigh";
            "msg": "rake basis points exceed the 10% ceiling";
        },
        {
            "code": 6002;
            "name": "invalidBucket";
            "msg": "bucket must be 0 (HOME), 1 (DRAW) or 2 (AWAY)";
        },
        {
            "code": 6003;
            "name": "zeroStake";
            "msg": "stake must be greater than zero";
        },
        {
            "code": 6004;
            "name": "potNotOpen";
            "msg": "pot is not open for calls";
        },
        {
            "code": 6005;
            "name": "notKickedOff";
            "msg": "pot has not kicked off yet";
        },
        {
            "code": 6006;
            "name": "potNotLocked";
            "msg": "pot is not locked";
        },
        {
            "code": 6007;
            "name": "potNotSettled";
            "msg": "pot is not settled";
        },
        {
            "code": 6008;
            "name": "potNotVoid";
            "msg": "pot is not voided";
        },
        {
            "code": 6009;
            "name": "proofRejected";
            "msg": "the on-chain proof does not confirm the claimed winning bucket";
        },
        {
            "code": 6010;
            "name": "alreadyClaimed";
            "msg": "this position has already been claimed";
        },
        {
            "code": 6011;
            "name": "wrongTxoracleProgram";
            "msg": "txoracle program account does not match the pinned config address";
        },
        {
            "code": 6012;
            "name": "mathOverflow";
            "msg": "arithmetic overflow";
        },
        {
            "code": 6013;
            "name": "wrongFixture";
            "msg": "proof fixture does not match this pot's fixture";
        },
        {
            "code": 6014;
            "name": "timestampOutOfWindow";
            "msg": "proof timestamp is outside this pot's match window";
        },
        {
            "code": 6015;
            "name": "wrongRootsAccount";
            "msg": "scores-roots account is not the txoracle PDA for this timestamp's day";
        },
        {
            "code": 6016;
            "name": "unauthorized";
            "msg": "only the config admin may perform this action";
        },
        {
            "code": 6017;
            "name": "kickoffInvalid";
            "msg": "kickoff must be in the future and within the allowed lead time";
        },
        {
            "code": 6018;
            "name": "voidTooEarly";
            "msg": "void timeout has not elapsed; only the admin may void earlier";
        },
        {
            "code": 6019;
            "name": "nothingToSweep";
            "msg": "no rake to sweep (already swept, or a voided pot)";
        },
        {
            "code": 6020;
            "name": "rakeExceedsFree";
            "msg": "rake exceeds the vault balance free after reserving unclaimed winners";
        },
        {
            "code": 6021;
            "name": "vaultUnderwater";
            "msg": "vault balance is below the outstanding winner liability";
        },
        {
            "code": 6022;
            "name": "wrongMint";
            "msg": "token account mint does not match the configured USDC mint";
        },
        {
            "code": 6023;
            "name": "sweepToVault";
            "msg": "cannot sweep rake into the pot's own vault";
        }
    ];
    "types": [
        {
            "name": "binaryExpression";
            "type": {
                "kind": "enum";
                "variants": [
                    {
                        "name": "add";
                    },
                    {
                        "name": "subtract";
                    }
                ];
            };
        },
        {
            "name": "comparison";
            "type": {
                "kind": "enum";
                "variants": [
                    {
                        "name": "greaterThan";
                    },
                    {
                        "name": "lessThan";
                    },
                    {
                        "name": "equalTo";
                    }
                ];
            };
        },
        {
            "name": "config";
            "docs": [
                "Global program config — one per deployment. Pins the USDC mint every Pot",
                "escrows in and the txoracle program every settlement CPIs into, so a Pot",
                "can never be steered at an attacker-controlled mint or a fake oracle."
            ];
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "admin";
                        "type": "pubkey";
                    },
                    {
                        "name": "usdcMint";
                        "type": "pubkey";
                    },
                    {
                        "name": "txoracleProgram";
                        "type": "pubkey";
                    },
                    {
                        "name": "rakeBps";
                        "docs": [
                            "House cut of the losers' pool, in basis points, routed to the Manager's Pot."
                        ];
                        "type": "u16";
                    },
                    {
                        "name": "minParticipants";
                        "docs": [
                            "Below this many distinct positions a Pot voids and refunds (thin-pool guard)."
                        ];
                        "type": "u8";
                    },
                    {
                        "name": "bump";
                        "type": "u8";
                    }
                ];
            };
        },
        {
            "name": "position";
            "docs": [
                "A single player's stake in one Pot's bucket. Pull-based: the player calls",
                "`claim` themselves after settlement, so a Pot with thousands of players",
                "never blows the compute budget on a settle-time payout loop."
            ];
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "pot";
                        "type": "pubkey";
                    },
                    {
                        "name": "player";
                        "type": "pubkey";
                    },
                    {
                        "name": "bucket";
                        "type": "u8";
                    },
                    {
                        "name": "stake";
                        "type": "u64";
                    },
                    {
                        "name": "claimed";
                        "type": "bool";
                    },
                    {
                        "name": "bump";
                        "type": "u8";
                    }
                ];
            };
        },
        {
            "name": "pot";
            "docs": [
                "One parimutuel Pot per (fixture, RESULT market). Holds real USDC in its",
                "vault PDA — funds only leave via `claim`, and only after `settle_pot` has",
                "proven the outcome on-chain by CPI into txoracle's `validate_stat`."
            ];
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "matchId";
                        "docs": [
                            "Stable id for this market (the backend's MatchId, ascii, left-padded)."
                        ];
                        "type": {
                            "array": [
                                "u8",
                                32
                            ];
                        };
                    },
                    {
                        "name": "txlineFixtureId";
                        "docs": [
                            "TxLINE's numeric fixture id — what settlement proves against."
                        ];
                        "type": "i64";
                    },
                    {
                        "name": "kickoff";
                        "type": "i64";
                    },
                    {
                        "name": "status";
                        "type": "u8";
                    },
                    {
                        "name": "winningBucket";
                        "docs": [
                            "Valid once SETTLED: which bucket the on-chain proof confirmed won."
                        ];
                        "type": "u8";
                    },
                    {
                        "name": "participants";
                        "type": "u32";
                    },
                    {
                        "name": "bucketTotals";
                        "docs": [
                            "USDC staked per bucket, index = bucket."
                        ];
                        "type": {
                            "array": [
                                "u64",
                                3
                            ];
                        };
                    },
                    {
                        "name": "totalStake";
                        "type": "u64";
                    },
                    {
                        "name": "rake";
                        "docs": [
                            "Set at settle: house rake taken from the losers' pool."
                        ];
                        "type": "u64";
                    },
                    {
                        "name": "distributable";
                        "docs": [
                            "Set at settle: losers' pool minus rake, split pro-rata among winners."
                        ];
                        "type": "u64";
                    },
                    {
                        "name": "winnersStake";
                        "docs": [
                            "Set at settle: total stake in the winning bucket (the pro-rata denominator)."
                        ];
                        "type": "u64";
                    },
                    {
                        "name": "paidOut";
                        "docs": [
                            "USDC that has left the vault — winner claims plus swept rake. Together",
                            "with the live balance this reconciles exactly: vault.amount + paid_out",
                            "== total_stake, for the pot's whole life."
                        ];
                        "type": "u64";
                    },
                    {
                        "name": "vaultBump";
                        "type": "u8";
                    },
                    {
                        "name": "bump";
                        "type": "u8";
                    }
                ];
            };
        },
        {
            "name": "proofNode";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "hash";
                        "type": {
                            "array": [
                                "u8",
                                32
                            ];
                        };
                    },
                    {
                        "name": "isRightSibling";
                        "type": "bool";
                    }
                ];
            };
        },
        {
            "name": "scoreStat";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "key";
                        "type": "u32";
                    },
                    {
                        "name": "value";
                        "type": "i32";
                    },
                    {
                        "name": "period";
                        "type": "i32";
                    }
                ];
            };
        },
        {
            "name": "scoresBatchSummary";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "fixtureId";
                        "type": "i64";
                    },
                    {
                        "name": "updateStats";
                        "type": {
                            "defined": {
                                "name": "scoresUpdateStats";
                            };
                        };
                    },
                    {
                        "name": "eventsSubTreeRoot";
                        "type": {
                            "array": [
                                "u8",
                                32
                            ];
                        };
                    }
                ];
            };
        },
        {
            "name": "scoresUpdateStats";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "updateCount";
                        "type": "i32";
                    },
                    {
                        "name": "minTimestamp";
                        "type": "i64";
                    },
                    {
                        "name": "maxTimestamp";
                        "type": "i64";
                    }
                ];
            };
        },
        {
            "name": "statTerm";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "statToProve";
                        "type": {
                            "defined": {
                                "name": "scoreStat";
                            };
                        };
                    },
                    {
                        "name": "eventStatRoot";
                        "type": {
                            "array": [
                                "u8",
                                32
                            ];
                        };
                    },
                    {
                        "name": "statProof";
                        "type": {
                            "vec": {
                                "defined": {
                                    "name": "proofNode";
                                };
                            };
                        };
                    }
                ];
            };
        },
        {
            "name": "traderPredicate";
            "type": {
                "kind": "struct";
                "fields": [
                    {
                        "name": "threshold";
                        "type": "i32";
                    },
                    {
                        "name": "comparison";
                        "type": {
                            "defined": {
                                "name": "comparison";
                            };
                        };
                    }
                ];
            };
        }
    ];
};
