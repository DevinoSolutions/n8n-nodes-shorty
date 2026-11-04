import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { readSummary, readTranscription, toTranscription } from '../Shorty/shared/jobs';
import { shortyRequest, throwApiError } from '../Shorty/shared/transport';
import { readHeader, signatureMatches, timestampIsFresh } from './signature';

/** The event types POST /v1/webhook-endpoints accepts (WEBHOOK_EVENT_TYPES in Shorty). */
export const EVENT_OPTIONS = [
	{
		name: 'Job Failed',
		value: 'job.failed',
		description: 'A summary or transcription job ended with an error',
	},
	{
		name: 'Job Succeeded',
		value: 'job.succeeded',
		description: 'A summary or transcription job finished successfully',
	},
];

/**
 * Shorty's verification handshake. POST /v1/webhook-endpoints sends it to the URL while the
 * request is still running, before its response hands over the signing secret, so it cannot be
 * verified; Shorty only delivers events to an endpoint that answered it with a 2xx. The node
 * answers it 200 and never starts the workflow for it.
 */
export const HANDSHAKE_EVENT = 'ping';

/** Shorty's "Send test event" from Settings > Webhooks. Signed, never subscribable. */
export const TEST_EVENT = 'test.ping';

/** Shorty's `ENDPOINT_DESCRIPTION_MAX_LENGTH`. */
const DESCRIPTION_MAX_LENGTH = 200;

/**
 * What the node keeps in the workflow's static data: the Shorty webhook endpoint it registered,
 * the signing secret Shorty shows once when the endpoint is created (n8n's own trigger nodes keep
 * their webhook IDs and secrets the same way), and the IDs of the last deliveries it accepted.
 *
 * n8n keeps this per mode: a production activation reads and writes the workflow's saved static
 * data, while "Listen for test event" starts from empty static data held with the test
 * registration only, so a test listen registers its own endpoint for the test URL and never sees,
 * replaces or deletes the production endpoint's ID or secret.
 */
interface WebhookState extends IDataObject {
	webhookId?: string;
	webhookSecret?: string;
	deliveryIds?: string[];
}

/** How many accepted delivery IDs are remembered to drop Shorty's retries of the same event. */
export const REMEMBERED_DELIVERIES = 200;

interface Envelope {
	type?: string;
	timestamp?: string;
	data?: IDataObject;
}

interface WebhookEndpoint {
	id: string;
	url: string;
	event_types: string[];
	enabled: boolean;
	verified_at: string | null;
}

function sameEvents(left: string[], right: string[]): boolean {
	const a = [...new Set(left)].sort();
	const b = [...new Set(right)].sort();
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseEnvelope(body: string | undefined): Envelope | null {
	if (body === undefined) return null;
	try {
		const parsed = JSON.parse(body) as unknown;
		return typeof parsed === 'object' && parsed !== null ? (parsed as Envelope) : null;
	} catch {
		return null;
	}
}

/** DELETE a registered endpoint; a 404 means it is already gone, which is the goal. */
async function removeEndpoint(this: IHookFunctions, endpointId: string): Promise<boolean> {
	const response = await shortyRequest.call(this, {
		method: 'DELETE',
		path: `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`,
	});
	return response.statusCode < 400 || response.statusCode === 404;
}

function endpointDescription(this: IHookFunctions): string {
	let name = '';
	try {
		name = this.getWorkflow().name ?? '';
	} catch {
		// A runtime without workflow metadata gets the plain label.
	}
	const label = name ? `n8n: ${name}` : 'n8n';
	return label.slice(0, DESCRIPTION_MAX_LENGTH);
}

export class ShortyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Shorty Trigger',
		name: 'shortyTrigger',
		icon: { light: 'file:../../icons/shorty.svg', dark: 'file:../../icons/shorty.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when a Shorty summary or transcription job finishes',
		defaults: {
			name: 'Shorty Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'shortyApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					"Shorty only delivers to a public HTTPS URL on port 443. A local n8n needs a public WEBHOOK_URL (a tunnel, for example). Each active trigger uses one of the account's 5 webhook endpoints.",
				name: 'publicUrlNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['job.succeeded'],
				options: EVENT_OPTIONS,
				description: 'The Shorty job events that start the workflow',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include Result',
						name: 'includeResult',
						type: 'boolean',
						default: true,
						description:
							'Whether to read the finished summary or transcription back from Shorty when a job succeeds, so the item carries the summary text or transcript. Each event then costs one API request.',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as WebhookState;
				if (!state.webhookId || !state.webhookSecret) return false;

				// The API reads endpoints as one list (at most 5, never paginated).
				const response = await shortyRequest.call(this, {
					method: 'GET',
					path: '/v1/webhook-endpoints',
				});
				if (response.statusCode >= 400) {
					throwApiError.call(this, response, 'Could not check the Shorty webhook endpoint:');
				}
				const endpoints = ((response.body as { data?: WebhookEndpoint[] }).data ??
					[]) as WebhookEndpoint[];
				const endpoint = endpoints.find((candidate) => candidate.id === state.webhookId);
				if (!endpoint) {
					delete state.webhookId;
					delete state.webhookSecret;
					return false;
				}

				const events = this.getNodeParameter('events', []) as string[];
				if (
					endpoint.url === this.getNodeWebhookUrl('default') &&
					endpoint.enabled &&
					endpoint.verified_at &&
					sameEvents(endpoint.event_types ?? [], events)
				) {
					return true;
				}
				// Another URL (n8n's base URL changed), other events, unverified, or auto-disabled after
				// 20 failed deliveries: remove it before `create` registers the replacement, so the old
				// one stops posting this account's events to a URL nobody verifies.
				if (!(await removeEndpoint.call(this, state.webhookId))) {
					throw new NodeOperationError(
						this.getNode(),
						'Could not remove the outdated Shorty webhook endpoint',
						{ description: 'Delete it in Shorty under Settings > Webhooks, then activate again.' },
					);
				}
				delete state.webhookId;
				delete state.webhookSecret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const events = this.getNodeParameter('events', []) as string[];
				const url = this.getNodeWebhookUrl('default');
				// Shorty pings `url` before it answers; the node's webhook method answers that ping.
				const response = await shortyRequest.call(this, {
					method: 'POST',
					path: '/v1/webhook-endpoints',
					body: { url, event_types: events, description: endpointDescription.call(this) },
				});
				if (response.statusCode === 400) {
					throwApiError.call(this, response, `Shorty refused n8n's webhook URL (${String(url)}):`);
				}
				if (response.statusCode >= 400) {
					throwApiError.call(
						this,
						response,
						'Shorty refused to register the webhook endpoint this trigger needs:',
					);
				}
				const created = response.body as { endpoint?: WebhookEndpoint; secret?: string };
				const endpoint = created.endpoint;
				if (!endpoint?.id || !created.secret) {
					// Without the secret no delivery can be verified, so an endpoint kept now would only
					// post requests this node refuses. Remove it, and fail the activation loudly: n8n
					// ignores what `create` returns, so `false` would leave a dead trigger "active".
					if (endpoint?.id) await removeEndpoint.call(this, endpoint.id);
					throw new NodeOperationError(
						this.getNode(),
						'Shorty registered the webhook endpoint without returning its signing secret',
						{ description: 'The endpoint was removed again. Activate the workflow again.' },
					);
				}
				if (!endpoint.verified_at) {
					// Shorty delivers events only to an endpoint that answered its ping with a 2xx. An
					// unverified one would leave a trigger that is on but never fires.
					await removeEndpoint.call(this, endpoint.id);
					throw new NodeOperationError(
						this.getNode(),
						"Shorty could not reach n8n's webhook URL to verify it",
						{
							description: `Shorty sent a verification request to ${String(url)} and got no 2xx answer, so the endpoint was removed again. Check that this URL is reachable from the internet, then activate again.`,
						},
					);
				}

				// The signing secret is shown once over the API, by this response only; it is kept to
				// verify every delivery.
				const state = this.getWorkflowStaticData('node') as WebhookState;
				state.webhookId = endpoint.id;
				state.webhookSecret = created.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as WebhookState;
				if (!state.webhookId) return true;
				// 404: already deleted in Shorty under Settings > Webhooks, which is the goal.
				if (!(await removeEndpoint.call(this, state.webhookId))) return false;
				delete state.webhookId;
				delete state.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const state = this.getWorkflowStaticData('node') as WebhookState;
		const request = this.getRequestObject();
		const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
		const rawBody: unknown = (request as { rawBody?: unknown }).rawBody;
		const body = Buffer.isBuffer(rawBody)
			? rawBody.toString('utf8')
			: typeof rawBody === 'string'
				? rawBody
				: undefined;

		// The verification handshake arrives while the endpoint is being created, before the node
		// holds its secret. Answering it 200 is all it needs; it never starts the workflow.
		const claimed = parseEnvelope(body);
		if (claimed?.type === HANDSHAKE_EVENT) {
			return { webhookResponse: { received: true } };
		}

		const id = readHeader(headers, 'webhook-id');
		const timestamp = readHeader(headers, 'webhook-timestamp');
		const signature = readHeader(headers, 'webhook-signature');
		const verified =
			!!state.webhookSecret &&
			body !== undefined &&
			!!id &&
			!!timestamp &&
			!!signature &&
			signatureMatches({
				secret: state.webhookSecret,
				id,
				timestamp,
				body,
				signatureHeader: signature,
			});

		if (!verified || !id || !timestamp) {
			// A forged request: refuse it without starting the workflow.
			this.getResponseObject().status(401).json({ error: 'Invalid Shorty webhook signature' });
			return { noWebhookResponse: true };
		}
		// Shorty signs every attempt, its retries included, with the time of that attempt, so a
		// genuine delivery is never older than its trip over the network. One signed more than five
		// minutes away from now is a captured request played back.
		if (!timestampIsFresh(timestamp)) {
			this.getResponseObject().status(401).json({ error: 'Stale Shorty webhook timestamp' });
			return { noWebhookResponse: true };
		}

		// Parsed from the exact bytes just verified, so nothing unverified feeds the item.
		const envelope = claimed ?? {};
		const events = this.getNodeParameter('events', []) as string[];
		const isTest = envelope.type === TEST_EVENT;
		if (!envelope.type || (!isTest && !events.includes(envelope.type))) {
			return { webhookResponse: { received: true } };
		}

		// Shorty re-sends an event until it gets a 2xx, with the same `webhook-id` each time
		// (at-least-once delivery). One already accepted is answered 200 and starts nothing. The list
		// is replaced rather than pushed to, so n8n sees the change and saves it.
		const seen = Array.isArray(state.deliveryIds) ? state.deliveryIds : [];
		if (seen.includes(id)) {
			return { webhookResponse: { received: true, duplicate: true } };
		}
		state.deliveryIds = [...seen, id].slice(-REMEMBERED_DELIVERIES);

		const job = (envelope.data ?? {}) as IDataObject;
		const output = (job.output ?? {}) as IDataObject;
		const outputId = typeof output.outputId === 'string' ? output.outputId : null;
		const item: IDataObject = {
			event: envelope.type,
			event_id: id,
			occurred_at: envelope.timestamp ?? null,
			test: isTest,
			job_id: job.jobId ?? null,
			status: job.status ?? null,
			job_type: output.jobType ?? null,
			title: output.title ?? null,
			output_id: outputId,
			error: job.error ?? null,
			job,
		};

		const options = this.getNodeParameter('options', {}) as IDataObject;
		const jobType = String(output.jobType ?? '');
		const isSummary = jobType === 'YOUTUBE_SUMMARY' || jobType === 'CONTENT_SUMMARY';
		const isTranscription = jobType === 'TRANSCRIPTION';
		if (
			options.includeResult === false ||
			isTest ||
			envelope.type !== 'job.succeeded' ||
			!outputId ||
			(!isSummary && !isTranscription)
		) {
			return { workflowData: [this.helpers.returnJsonArray([item])] };
		}

		// The read-back is one more API call. In the "onReceived" response mode n8n answers only after
		// this method returns, and Shorty abandons an attempt after 10 seconds and retries it, so the
		// node sends the 200 itself first; `noWebhookResponse` then stops n8n from answering a second
		// time. The delivery ID is recorded above, so a retry that still raced this answer would start
		// nothing. Read-back failures leave the result empty and never throw, because the answer is
		// already sent.
		this.getResponseObject().status(200).json({ received: true });
		try {
			if (isSummary) {
				item.summary = await readSummary.call(this, outputId, String(job.jobId ?? ''));
			} else {
				item.transcription = toTranscription(
					await readTranscription.call(this, outputId),
					String(job.jobId ?? ''),
				);
			}
		} catch {
			item[isSummary ? 'summary' : 'transcription'] = null;
		}

		return {
			noWebhookResponse: true,
			workflowData: [this.helpers.returnJsonArray([item])],
		};
	}
}
