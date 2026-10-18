import { runStyleBuild } from "./styles/build";

process.exitCode = runStyleBuild(process.cwd(), process.argv.slice(2));
