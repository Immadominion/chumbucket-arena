import { VenueError } from "./errors.ts";

/** Panta is the only deployable prediction provider. Never echo config values. */
export function livePredictionVenue(requested: string | undefined): "panta" {
  if (requested === undefined || requested === "" || requested === "panta") return "panta";
  throw new VenueError(
    "VENUE_MISCONFIGURED",
    "Chumbucket predictions use Panta only. Remove PREDICTION_VENUE or set it to panta; no other provider or demo fallback is enabled.",
    { venue: "panta" },
  );
}
