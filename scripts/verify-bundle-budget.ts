import { runBundleBudget } from "./bundle-budget";

process.exitCode = await runBundleBudget(process.cwd(), process.argv.slice(2));
