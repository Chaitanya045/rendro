import { runBundleBudget } from "./bundle-budget";

process.exitCode = runBundleBudget(process.cwd(), process.argv.slice(2));
