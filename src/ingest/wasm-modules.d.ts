/** Workers bundlers (wrangler) import .wasm files as compiled modules. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
