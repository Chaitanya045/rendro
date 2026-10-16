import { sanitizeLogFields } from "./log-redaction";
import pino from "pino";
import { LOG_LEVEL, NODE_ENV } from "./config";

const isDev = NODE_ENV !== "production";

const sink = pino({
  level: LOG_LEVEL,
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

const levels = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
type LogMethod = (fields: unknown, message?: string) => void;
type SafeLogger = Record<(typeof levels)[number], LogMethod> & {
  child(bindings: Record<string, unknown>): SafeLogger;
};

// Only expose the application logging API: raw Pino children, serializers and
// interpolation arguments must not bypass the shared Node/Worker policy.
function createLogger(bindings: Record<string, unknown> = {}): SafeLogger {
  const methods = Object.fromEntries(levels.map(level => [level, (fields: unknown, message?: string) => {
    const record = sanitizeLogFields({
      ...bindings,
      ...(typeof fields === "object" ? sanitizeLogFields(fields) : {}),
    });
    // Messages are static application-authored text, never request diagnostics.
    sink[level](record, typeof fields === "string" ? fields : message);
  }])) as Record<(typeof levels)[number], LogMethod>;
  return {
    ...methods,
    child: fields => createLogger(sanitizeLogFields({ ...bindings, ...sanitizeLogFields(fields) })),
  };
}

export const logger = createLogger();
