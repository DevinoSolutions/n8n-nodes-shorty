import { createHash, randomUUID } from 'crypto';
import { sleep } from 'n8n-workflow';
import type { ShortyResponse } from './transport';

/** The API's bound on `Idempotency-Key`: 1 to 255 visible ASCII characters, no spaces. */
const MAX_KEY_LENGTH = 255;
const KEY_SAFE = /^[!-~]+$/;

/**
 * Where one job start sits inside n8n: the instance, workflow, execution, node, run of that node
 * and input item. n8n's "Retry On Fail" re-runs a failed node inside the same execution, with the
 * same run index and the same items, so every part stays the same across those tries. A loop (or
 * an AI Agent calling the node as a tool) runs the node again with a new run index, and a manual
 * "Retry" of a failed execution starts a new execution with a new ID.
 */
export interface StartPosition {
	instanceId?: string;
	workflowId?: string;
	executionId?: string;
	nodeName: string;
	runIndex: number;
	itemIndex: number;
}

/**
 * The `Idempotency-Key` for a `POST /v1/summaries` or `POST /v1/transcriptions`.
 *
 * A key the user mapped (say, the ID of the row that triggered the workflow) is used as-is,
 * namespaced by operation: Shorty replays the first answer for 24 hours instead of starting a
 * second job, in this execution or any other, and refuses the key for a different body.
 *
 * Without one, the key is derived from the start's position in the execution, so n8n's Retry On
 * Fail, which re-runs the whole node with every item, gets the jobs already started back instead
 * of starting (and paying for) them again. It never merges two different starts: each item, each
 * run of the node and each execution gets its own key. When n8n gives no execution ID, the key is
 * random, which still covers the single retry below.
 */
export function createIdempotencyKey(
	operation: 'summary' | 'transcription',
	userKey: unknown,
	position: StartPosition,
): string {
	if (typeof userKey === 'string' && userKey.trim() !== '') {
		// Namespaced, so a bare row ID cannot collide with a key the customer's own backend sends.
		// A value that is too long or not header-safe would be refused, so it is hashed instead.
		const key = `n8n-${operation}:${userKey.trim()}`;
		return key.length <= MAX_KEY_LENGTH && KEY_SAFE.test(key)
			? key
			: `n8n-${operation}:${createHash('sha256').update(key).digest('hex')}`;
	}
	if (!position.executionId) return `n8n-${randomUUID()}`;
	return `n8n-run:${createHash('sha256')
		.update(
			[
				`${operation}-create`,
				position.instanceId ?? '',
				position.workflowId ?? '',
				position.executionId,
				position.nodeName,
				String(position.runIndex),
				String(position.itemIndex),
			].join('\n'),
		)
		.digest('hex')}`;
}

/**
 * Worth sending again with the same key: a 5xx, or 409 `idempotency_in_progress` (the first
 * request under this key is still running). Shorty replays the first request's stored answer or
 * runs it once, never twice. Any other 409 is a real conflict and is returned as it is.
 */
export function isRetryable(response: ShortyResponse): boolean {
	if (response.statusCode >= 500) return true;
	if (response.statusCode !== 409) return false;
	const code = (response.body as { code?: unknown } | undefined)?.code;
	return code === 'idempotency_in_progress';
}

/** Pause before the single retry. Exported so tests can shorten it. */
export const retrySettings = { delayMs: 1500 };

/**
 * Runs `send` and, once, again after a short pause when the first answer is retryable or the
 * request failed without an answer (a reset connection or a timeout, where the first request may
 * or may not have reached Shorty). Both attempts carry the caller's single idempotency key and the
 * same body, so Shorty starts the job at most once. A second failure is returned or thrown as it
 * is.
 */
export async function sendWithOneRetry<T>(
	send: () => Promise<ShortyResponse<T>>,
): Promise<ShortyResponse<T>> {
	let first: ShortyResponse<T> | undefined;
	try {
		first = await send();
	} catch {
		// No answer: fall through to the retry below.
	}
	if (first !== undefined && !isRetryable(first as ShortyResponse)) return first;
	await sleep(retrySettings.delayMs);
	return await send();
}
