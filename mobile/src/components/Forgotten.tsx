import { Unlink } from "lucide-react";
import { PrimaryButton } from "./ui";

/** The PC removed this phone (Settings → Phone → Remove). */
export function Forgotten({ pcName, onPairAgain }: { pcName: string; onPairAgain: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center pt-safe pb-safe" data-testid="forgotten">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.06]">
        <Unlink className="h-7 w-7 text-gray-300" />
      </div>
      <h1 className="mt-6 text-2xl font-semibold">{pcName} doesn't know this phone anymore</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-gray-400">It was removed in Soundwave AI → Settings → Phone. Pair again to keep chatting.</p>
      <div className="mt-10 w-full">
        <PrimaryButton onClick={onPairAgain}>Pair again</PrimaryButton>
      </div>
    </div>
  );
}
