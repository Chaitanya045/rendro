import { runFontBuild } from "./fonts/build";

process.exitCode = await runFontBuild(process.cwd(), process.argv.slice(2));
