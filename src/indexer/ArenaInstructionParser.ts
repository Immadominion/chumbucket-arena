import idl from "../../vendor/chumbucket_arena/chumbucket_arena.json" with { type: "json" };

export const DEFAULT_ARENA_PROGRAM_ID = "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG";

export interface ParsedArenaInstruction {
  name: "place_call" | "claim" | "settle_pot" | "void_pot";
  programId: string;
  accounts: string[];
  namedAccounts: Record<string, string>;
  args: Record<string, string | number>;
}

const TARGET_NAMES = new Set(["place_call", "claim", "settle_pot", "void_pot"]);

const SPECS = Object.fromEntries(
  (idl.instructions as Array<{ name: string; discriminator: number[]; accounts?: Array<{ name: string }> }>)
    .filter((ix) => TARGET_NAMES.has(ix.name))
    .map((ix) => [
      ix.name,
      {
        name: ix.name as ParsedArenaInstruction["name"],
        discriminator: Buffer.from(ix.discriminator),
        accountNames: ix.accounts?.map((a) => a.name) ?? [],
      },
    ]),
) as Record<
  ParsedArenaInstruction["name"],
  { name: ParsedArenaInstruction["name"]; discriminator: Buffer; accountNames: string[] }
>;

export function extractArenaInstructions(
  body: unknown,
  programId = DEFAULT_ARENA_PROGRAM_ID,
): ParsedArenaInstruction[] {
  const out: ParsedArenaInstruction[] = [];
  for (const row of instructionObjects(body)) {
    const rowProgramId = stringVal(row.programId) ?? stringVal(row.programID) ?? stringVal(row.program);
    const programName = stringVal(row.programName) ?? stringVal(row.program);
    if (rowProgramId !== programId && programName !== "chumbucket_arena") continue;

    const accounts = accountList(row.accounts);
    const data = stringVal(row.data) ?? stringVal(row.instructionData);
    const decoded = data ? decodeInstructionData(data) : undefined;
    const byData = decoded ? parseByDiscriminator(decoded, rowProgramId ?? programId, accounts) : undefined;
    if (byData) {
      out.push(byData);
      continue;
    }

    const byName = parseByName(row, rowProgramId ?? programId, accounts);
    if (byName) out.push(byName);
  }
  return dedupe(out);
}

function parseByDiscriminator(
  data: Buffer,
  programId: string,
  accounts: string[],
): ParsedArenaInstruction | undefined {
  for (const spec of Object.values(SPECS)) {
    if (data.length < spec.discriminator.length || !data.subarray(0, 8).equals(spec.discriminator)) continue;
    const args: Record<string, string | number> = {};
    if (spec.name === "place_call" && data.length >= 17) {
      args.bucket = data.readUInt8(8);
      args.amount = data.readBigUInt64LE(9).toString();
    }
    if (spec.name === "settle_pot" && data.length >= 9) {
      args.winningBucket = data.readUInt8(8);
    }
    return {
      name: spec.name,
      programId,
      accounts,
      namedAccounts: namedAccounts(spec.accountNames, accounts),
      args,
    };
  }
  return undefined;
}

function parseByName(
  row: Record<string, unknown>,
  programId: string,
  accounts: string[],
): ParsedArenaInstruction | undefined {
  const name = normalizeName(
    stringVal(row.instructionName) ??
      stringVal(row.name) ??
      stringVal(row.type) ??
      stringVal(row.parsedInstruction),
  );
  if (!name || !TARGET_NAMES.has(name)) return undefined;
  const spec = SPECS[name as ParsedArenaInstruction["name"]];
  return {
    name: spec.name,
    programId,
    accounts,
    namedAccounts: namedAccounts(spec.accountNames, accounts),
    args: argsObject(row.args),
  };
}

function* instructionObjects(body: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(body)) {
    for (const item of body) yield* instructionObjects(item);
    return;
  }
  if (!isObject(body)) return;

  if ("programId" in body || "programID" in body || "programName" in body) {
    yield body;
  }

  for (const key of ["instructions", "innerInstructions", "events", "transaction", "message"]) {
    if (key in body) yield* instructionObjects(body[key]);
  }
}

function accountList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((a) => (typeof a === "string" ? a : isObject(a) ? stringVal(a.pubkey) ?? stringVal(a.account) : undefined))
    .filter((a): a is string => !!a);
}

function namedAccounts(names: string[], accounts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    const account = accounts[i];
    if (account) out[names[i]!] = account;
  }
  return out;
}

function argsObject(v: unknown): Record<string, string | number> {
  if (!isObject(v)) return {};
  const out: Record<string, string | number> = {};
  for (const [k, value] of Object.entries(v)) {
    if (typeof value === "string" || typeof value === "number") out[k] = value;
  }
  return out;
}

function decodeInstructionData(raw: string): Buffer | undefined {
  try {
    return decodeBase58(raw);
  } catch {
    // Fall through to base64 below.
  }
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return undefined;
  }
}

function decodeBase58(raw: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const char of raw) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("invalid base58");
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of raw) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

function dedupe(rows: ParsedArenaInstruction[]): ParsedArenaInstruction[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify([row.name, row.programId, row.accounts, row.args]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeName(v: string | undefined): string | undefined {
  return v?.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, "").toLowerCase();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stringVal(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
