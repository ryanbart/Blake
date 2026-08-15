import { jwtVerify, SignJWT } from "jose";
import { DialpadCallEvent } from "./types";

/**
 * Dialpad delivers call events as HS256-signed JWTs whose payload is the event.
 *
 * Nothing from a webhook reaches the database before this passes. An unsigned or
 * tampered payload is indistinguishable from an attacker posting to the public
 * endpoint, so verification is not optional and the failure is loud.
 */

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Verify a signed webhook body and return the decoded call event.
 *
 * @param token  Raw JWT from the request body.
 * @param secret The secret Dialpad returned when the webhook was registered.
 */
export async function verifyCallEvent(
  token: string,
  secret: string,
): Promise<DialpadCallEvent> {
  if (!secret) {
    throw new WebhookVerificationError(
      "DIALPAD_WEBHOOK_SECRET is not set; refusing to trust an unverifiable payload.",
    );
  }
  if (!token || token.split(".").length !== 3) {
    throw new WebhookVerificationError("Body is not a JWT.");
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, secretKey(secret), {
      algorithms: ["HS256"], // pinned: never let the token pick "none"
      clockTolerance: 60,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    throw new WebhookVerificationError(
      `Signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = DialpadCallEvent.safeParse(payload);
  if (!parsed.success) {
    throw new WebhookVerificationError(
      `Signature valid but payload is not a call event: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Sign a payload as Dialpad would. Test helper — not used in production paths. */
export async function signCallEvent(
  payload: Record<string, unknown>,
  secret: string,
  { expiresIn = "5m" }: { expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey(secret));
}
