import { formatEvalReport, runEvalSuite } from "./runner.js";
import { deterministicCases } from "./suite.js";
import { liveEvalCases } from "./live.js";

async function main(): Promise<void> {
  const cases = [...deterministicCases(), ...liveEvalCases()];
  const summary = await runEvalSuite(cases);
  console.log(formatEvalReport(summary));
  if (process.env.ICLAW_EVAL_LIVE !== "1") {
    console.log("（提示：设置 ICLAW_EVAL_LIVE=1 可追加实模型端到端用例。）");
  }
  process.exit(summary.failed > 0 ? 1 : 0);
}

void main();
