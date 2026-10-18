import { runComrakWasm } from "./comrak-wasm/build";

runComrakWasm(process.cwd(), process.argv.slice(2));
