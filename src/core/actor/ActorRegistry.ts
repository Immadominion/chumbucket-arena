/**
 * Looks up (and lazily creates) the actor for a wallet. One actor per player for
 * the life of the process; the actor rehydrates its stream version on first use.
 */

import type { Wallet } from "../../domain/ids.ts";
import { PlayerActor, type PlayerActorDeps } from "./PlayerActor.ts";

export class ActorRegistry {
  private readonly actors = new Map<Wallet, PlayerActor>();

  constructor(private readonly deps: PlayerActorDeps) {}

  for(wallet: Wallet): PlayerActor {
    let actor = this.actors.get(wallet);
    if (!actor) {
      actor = new PlayerActor(wallet, this.deps);
      this.actors.set(wallet, actor);
    }
    return actor;
  }
}
