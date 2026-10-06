// Which build this is.
//
// Soundwave ships two desktop builds from this one codebase: the retail build
// people buy, and the owner's own build ("Soundwave AI — Dev") that has no
// payment in it at all. The only difference is this environment value — the
// code, the UI and the plan names are the same, so the two can't drift apart.
//
//   retail   (default)  plans are sold: Stripe Checkout, the Billing Portal and
//                       the plan gates all work.
//   personal            there is nothing to buy and nothing to gate: the plan in
//                       force is ENTERPRISE and the billing routes say so
//                       instead of pretending to charge.
//
// The desktop shell sets it (desktop/src/server-env.cjs) from the edition baked
// into the build (desktop/src/edition.cjs).
import type { Plan } from "./plans.js";

export type Edition = "retail" | "personal";

export const edition: Edition = process.env.SOUNDWAVE_EDITION?.trim().toLowerCase() === "personal" ? "personal" : "retail";

/** The owner's own build: no payments, no plan in the way. */
export const personalEdition = edition === "personal";

/** Billing is a retail thing; in the personal build every billing route refuses. */
export const billingEnabled = !personalEdition;

/**
 * The plan actually in force for an account — what every gate, quota and API
 * response must use. On the owner's own PC there is nobody to sell to, so the
 * answer is Enterprise whatever the stored record says (a fresh install, an old
 * FREE record from before, a hand-edited store). Nothing is written back: the
 * stored plan stays what it is, this is the truth of what the build allows.
 */
export function effectivePlan(plan: Plan): Plan {
  return personalEdition ? "ENTERPRISE" : plan;
}
