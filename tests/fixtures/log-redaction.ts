import { stdSerializers } from "pino";
import type { logger as applicationLogger } from "../../src/logger";

export const logSecret = "SYNTHETIC_PRIVATE_CAPABILITY_88";

// Run identical inputs through real Node Pino and the Worker-selected bundle.
export function exerciseLogRedaction(logger: typeof applicationLogger) {
  const secret = logSecret;
  const query = `?token=${secret}`;
  const faulty = () => Object.assign(new TypeError(`https://example.test/share/${secret}${query}`), {
    name: secret, stack: secret, cause: { authorization: `Bearer ${secret}` }, url: `/s/${secret}`,
  });
  const nested: Record<string, unknown> = { safe: 42, token: secret };
  nested.loop = nested;
  const fields = {
    Authorization: `Bearer ${secret}`, authorization: secret, Cookie: secret, "set-cookie": secret,
    password: secret, passwordHash: secret, newPassword: secret, rawKey: secret, api_key: secret,
    access_token: secret, refreshToken: secret, sessionToken: secret, viewerTicket: secret,
    invitationId: secret, verificationToken: secret, resetToken: secret, clientSecret: secret,
    url: `/s/${secret}${query}`, callbackURL: `/verify-email?token=${secret}`, requestPath: `/share/${secret}`, path: `/share/${secret}`, body: secret,
    err: faulty(), error: secret, errorType: secret, cause: faulty(), stack: secret,
    nested: [null, false, { deeper: { fields: { token: secret, authorization: secret, secret } } }],
    circular: nested, toJSON: () => ({ secret }),
  };
  logger.debug(fields, "structured fixture");
  logger.error(faulty(), "exception fixture");
  logger.error(faulty());
  logger.error({ err: faulty() });
  logger.info(null, "null fixture");
  logger.error({ error: new RangeError(secret), other: new Error(secret) }, "error categories");
  logger.error({ errorType: "TypeError" }, "safe type");
  logger.error({ error: null, err: 0 }, "empty errors");
  logger.error({ errorType: { toString: () => "TypeError", secret } }, "unsafe type");
  logger.child(fields).info({ token: secret }, "child fixture");

  const credentials = [
    "authorization", "cookie", "set-cookie", "password", "newPassword", "currentPassword",
    "token", "accessToken", "refreshToken", "idToken", "sessionToken", "apiKey", "secret",
    "rawKey", "key", "credential", "credentials", "clientSecret", "ticket", "viewerTicket",
    "shareToken", "resetToken", "verificationToken", "invitationToken", "invitationId", "internalSecret",
  ];
  const allCredentials = Object.fromEntries(credentials.map(key => [key, secret]));
  logger.warn({ allCredentials, nested: [{ fields: allCredentials }], msg: secret }, "all credentials");
  logger.fatal({ err: stdSerializers.err(faulty()), error: stdSerializers.err(new RangeError(secret)) }, "serialized errors");
  logger.trace({ safe: 1 }, "trace fixture");
  logger.info("static message");
  logger.info(undefined);
  const bindings = { ...fields, safe: "parent", mutable: { safe: "original" } };
  const child = logger.child(bindings);
  bindings.mutable.safe = secret;
  child.child({ ...allCredentials, safe: "child", err: stdSerializers.err(faulty()) })
    .info({ safe: "record", other: faulty() }, "grandchild fixture");
  child.info("child message");
  child.error(new RangeError(secret));
  logger.info({ safe: "root" }, "root fixture");
}
