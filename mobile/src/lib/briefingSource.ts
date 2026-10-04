// ── Who writes today's briefing? ────────────────────────────────────────────
// The PC normally writes it (it has the memory and the agent), and the phone
// speaks what it wrote. With the PC off, the phone writes it itself — that is
// the whole reason it keeps the PC's key ("Chat without the PC").
//
// The phone's own connection phases are not a pair. Before it settles on
// "offline" it is "connecting" (knocking on the address it was paired with) and
// "searching" (sweeping the known /24s if the address moved), which can take
// seconds. A person opening the app at 06:30 with the PC off must not be told
// the briefing can't happen because that decision is still in flight — and it
// must never be told the phone "has no key" when it is holding one.
//
// So the rule is deliberately not "is the PC province offline?" but "can this
// phone write it?": yes, whenever it is not forgotten and holds the key.

export type CompanionPhase = "connecting" | "searching" | "online" | "offline" | "forgotten";

/**
 * Can the phone write today's briefing itself right now? True whenever it holds
 * the PC's key and the PC has not removed this phone — whatever the state of
 * the connection, including states that only mean "not decided yet".
 */
export function canWriteBriefingOnPhone(phase: CompanionPhase, hasKit: boolean): boolean {
  if (phase === "forgotten") return false; // the PC removed this phone: it keeps nothing of it
  return hasKit;
}

/**
 * The sentence a person reads when the briefing couldn't happen. Named by what
 * was actually true — a phone that holds the key is never told it doesn't, and
 * a PC that never answered is described as unreachable rather than off.
 */
export function briefingFailureNote(
  phase: CompanionPhase,
  opts: { pcRefusedNote?: string | null; hasKit?: boolean } = {},
): string {
  if (phase === "online") {
    const pc = `your PC couldn't write today's briefing when this phone asked it just now${
      opts.pcRefusedNote ? ` (${opts.pcRefusedNote})` : ""
    }`.replace(/^your PC/, "Your PC");
    // Say what the phone could not do, and why — never a reason that belonged to
    // an earlier attempt (the note is only ever what the PC said *this* time).
    return opts.hasKit
      ? `${pc}, and writing one here didn't work either — try again in a moment`
      : `${pc}, and this phone hasn't got the key it needs to write one here (that comes from the PC) — open Soundwave on the PC once, then ask again`;
  }
  if (phase === "forgotten") return "this phone isn't paired with your PC any more — pair it again from the PC (Settings → Phone)";
  return "Soundwave hasn't reached your PC yet, and this phone hasn't got the PC's key to write a briefing by itself (that arrives in the background while the PC is on) — open Soundwave on the PC once, then ask again";
}
