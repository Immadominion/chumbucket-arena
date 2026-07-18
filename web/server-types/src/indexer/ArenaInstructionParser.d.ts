export declare const DEFAULT_ARENA_PROGRAM_ID = "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG";
export interface ParsedArenaInstruction {
    name: "place_call" | "claim" | "settle_pot" | "void_pot";
    programId: string;
    accounts: string[];
    namedAccounts: Record<string, string>;
    args: Record<string, string | number>;
}
export declare function extractArenaInstructions(body: unknown, programId?: string): ParsedArenaInstruction[];
