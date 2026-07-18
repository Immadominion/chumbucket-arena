/**
 * Looks up (and lazily creates) the actor for a wallet. One actor per player for
 * the life of the process; the actor rehydrates its stream version on first use.
 */
import type { Wallet } from "../../domain/ids";
import { PlayerActor, type PlayerActorDeps } from "./PlayerActor";
export declare class ActorRegistry {
    private readonly deps;
    private readonly actors;
    constructor(deps: PlayerActorDeps);
    for(wallet: Wallet): PlayerActor;
}
