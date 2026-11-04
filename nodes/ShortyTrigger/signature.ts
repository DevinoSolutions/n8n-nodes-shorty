import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Shorty signs every webhook delivery with Standard Webhooks headers: `webhook-id` (the event's
 * stable ID, the same on every retry), `webhook-timestamp` (unix seconds of that attempt) and
 * `webhook-signature`, a space-separated list of `v1,<base64 HMAC-SHA256(key, "id.timestamp.body")>`.
 * During a secret rotation it carries one signature per active secret, so any match passes.
 */

/**
 * The key bytes a secret signs with: the base64-DECODED part after `whsec_` (Shorty's
 * src/lib/webhooks/signing.ts and the `verifyWebhookSignature` helper of @aishorty/sdk).
 */
export function signingKey(secret: string): Buffer {
	const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
	return Buffer.from(raw, 'base64');
}

export function computeSignature(
	secret: string,
	id: string,
	timestamp: string,
	body: string,
): string {
	return createHmac('sha256', signingKey(secret))
		.update(`${id}.${timestamp}.${body}`, 'utf8')
		.digest('base64');
}

export function signatureMatches(options: {
	secret: string;
	id: string;
	timestamp: string;
	body: string;
	signatureHeader: string;
}): boolean {
	const { secret, id, timestamp, body, signatureHeader } = options;
	const expected = Buffer.from(computeSignature(secret, id, timestamp, body), 'base64');
	return signatureHeader
		.split(' ')
		.filter((candidate) => candidate.length > 0)
		.some((candidate) => {
			const comma = candidate.indexOf(',');
			if (comma < 0 || candidate.slice(0, comma) !== 'v1') return false;
			const given = Buffer.from(candidate.slice(comma + 1), 'base64');
			return (
				given.length > 0 && given.length === expected.length && timingSafeEqual(given, expected)
			);
		});
}

/** How far a delivery's signed `webhook-timestamp` may be from now, either way (seconds). */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Whether a signed `webhook-timestamp` (unix seconds) is within the tolerance of `nowMs`: Shorty's
 * own ±5-minute replay window. The timestamp is part of what is signed, so an attacker who
 * captured a delivery cannot move it forward.
 */
export function timestampIsFresh(timestamp: string, nowMs: number = Date.now()): boolean {
	if (!/^\d{1,12}$/.test(timestamp)) return false;
	return Math.abs(nowMs / 1000 - Number(timestamp)) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/** Header lookup that ignores case, for any header map n8n hands over. */
export function readHeader(
	headers: Record<string, string | string[] | undefined> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) {
			return Array.isArray(value) ? value[0] : value;
		}
	}
	return undefined;
}
