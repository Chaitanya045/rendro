import { logRedaction } from "./log-redaction";
import pino from "pino";
import { LOG_LEVEL, NODE_ENV } from "./config";

const isDev = NODE_ENV !== "production";

export const logger = pino({
  level: LOG_LEVEL,
  ...logRedaction,
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});
