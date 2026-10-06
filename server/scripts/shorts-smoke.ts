// Live check of the free Shorts trend tracker against real YouTube (CI only —
// the dev sandbox can't reach YouTube). Prints the findings and top Shorts and
// fails if YouTube's layout changed so much that nothing parses any more.
import { scanTrendingShorts } from "../src/lib/shortsTrends.js";

const scan = await scanTrendingShorts();
console.log(`queries: ${scan.queries.length}, failed searches: ${scan.failures}, shorts: ${scan.shorts.length}`);
for (const f of scan.findings) console.log(`• ${f}`);
for (const s of scan.shorts.slice(0, 10)) console.log(`  ${s.views.toLocaleString("en")} views · ${s.ageHours ?? "?"}h · ${s.seconds ?? "?"}s · ${s.title} — ${s.url}`);
if (scan.shorts.length < 10 || scan.findings.length < 3) {
  console.error("Too little came back — YouTube's result layout may have changed.");
  process.exit(1);
}
