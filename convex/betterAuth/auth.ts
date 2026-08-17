import { createAuth } from "../auth";

// Static instance consumed only by `npx auth generate`.
export const auth = createAuth({} as never, true);
