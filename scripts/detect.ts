/** Runs the change engine over stored history. Run: npm run detect */
import { runDetection } from "@/lib/detection";
import { FULL_UNIVERSE } from "@/lib/universe";

const t = Date.now();
const result = await runDetection([...FULL_UNIVERSE]);
console.log({ ...result, ms: Date.now() - t });
process.exit(0);
