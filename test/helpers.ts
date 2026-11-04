/**
 * A minimal stand-in for the n8n runtime: just enough of IExecuteFunctions, IHookFunctions,
 * IWebhookFunctions and ILoadOptionsFunctions for the node code, with every HTTP call answered
 * from a queue of canned responses and recorded for assertions. No network is ever touched.
 *
 * Every call is recorded with the credential it was sent with, so a test can prove each request
 * carries the Shorty credential.
 */
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodeExecutionData,
	IWebhookFunctions,
} from 'n8n-workflow';
import { retrySettings } from '../nodes/Shorty/shared/idempotency';
import { jobWaitSettings } from '../nodes/Shorty/shared/jobs';

// The single retry after a 5xx/409 waits 1.5s and job polling 5s in production; tests do not wait.
// The polling interval itself stays 5s, so a timeout still bounds how many polls run.
retrySettings.delayMs = 0;
jobWaitSettings.pause = async () => {};

export interface MockResponse {
	statusCode: number;
	body?: unknown;
	headers?: IDataObject;
	/** Throw this instead of answering, as a reset connection or a timeout does. */
	networkError?: string;
}

export interface RecordedCall {
	/** `null` for a request sent without any credential. */
	credentialName: string | null;
	method: string;
	url: string;
	qs?: IDataObject;
	body?: unknown;
	headers: IDataObject;
	options: IHttpRequestOptions;
}

export class MockHttp {
	readonly calls: RecordedCall[] = [];

	private readonly queue: MockResponse[];

	constructor(responses: MockResponse[] = []) {
		this.queue = [...responses];
	}

	push(...responses: MockResponse[]): void {
		this.queue.push(...responses);
	}

	get remaining(): number {
		return this.queue.length;
	}

	async handle(credentialName: string | null, options: IHttpRequestOptions) {
		this.calls.push({
			credentialName,
			method: String(options.method ?? 'GET'),
			url: String(options.url),
			qs: options.qs as IDataObject | undefined,
			body: options.body,
			headers: (options.headers ?? {}) as IDataObject,
			options,
		});
		const next = this.queue.shift();
		if (!next) {
			throw new Error(`Unexpected request: ${String(options.method)} ${String(options.url)}`);
		}
		if (!options.returnFullResponse || !options.ignoreHttpStatusErrors) {
			throw new Error('The node must ask for the full response and handle error statuses itself');
		}
		if (next.networkError) throw new Error(next.networkError);
		return { statusCode: next.statusCode, body: next.body ?? {}, headers: next.headers ?? {} };
	}
}

const NODE: INode = {
	id: 'node-1',
	name: 'Shorty',
	type: 'n8n-nodes-shorty.shorty',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function lookup(parameters: IDataObject, name: string): unknown {
	let current: unknown = parameters;
	for (const part of name.split('.')) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as IDataObject)[part];
	}
	return current;
}

function getParameter(
	parameters: IDataObject,
	name: string,
	fallback: unknown,
	options?: { extractValue?: boolean },
	hasFallback = true,
): unknown {
	let value = lookup(parameters, name);
	if (value === undefined) {
		if (!hasFallback) throw new Error(`Missing parameter '${name}' in the test setup`);
		return fallback;
	}
	if (
		options?.extractValue &&
		value !== null &&
		typeof value === 'object' &&
		'__rl' in (value as IDataObject)
	) {
		value = (value as IDataObject).value;
	}
	return value;
}

/** A resource locator value, as n8n stores it. */
export function locator(value: string, mode = 'list'): IDataObject {
	return { __rl: true, mode, value };
}

const helpers = {
	returnJsonArray(items: IDataObject | IDataObject[]): INodeExecutionData[] {
		return (Array.isArray(items) ? items : [items]).map((json) => ({ json }));
	},
	constructExecutionMetaData(
		items: INodeExecutionData[],
		options: { itemData: { item: number } },
	): INodeExecutionData[] {
		return items.map((item) => ({ ...item, pairedItem: options.itemData }));
	},
};

export interface ExecutionPosition {
	/** `null` stands for a runtime that gives no execution ID. */
	executionId?: string | null;
	runIndex?: number;
	nodeName?: string;
	workflowId?: string;
	instanceId?: string;
}

export function executeContext(
	itemParameters: IDataObject[],
	http: MockHttp,
	options: {
		continueOnFail?: boolean;
		position?: ExecutionPosition;
	} = {},
): IExecuteFunctions {
	const position = options.position ?? {};
	const executionId = position.executionId === undefined ? '1001' : position.executionId;
	return {
		getInputData: () => itemParameters.map(() => ({ json: {} })),
		getExecutionId: () => executionId ?? undefined,
		getInstanceId: () => position.instanceId ?? 'instance-a',
		getWorkflow: () => ({ id: position.workflowId ?? 'wf-1', name: 'Test', active: false }),
		getWorkflowDataProxy: () => ({ $thisRunIndex: position.runIndex ?? 0 }),
		// A plain function, so `arguments.length` tells "no fallback given" from "fallback undefined".
		getNodeParameter: function (
			name: string,
			itemIndex: number,
			fallback?: unknown,
			parameterOptions?: { extractValue?: boolean },
		) {
			return getParameter(
				itemParameters[itemIndex],
				name,
				fallback,
				parameterOptions,
				arguments.length > 2,
			);
		},
		getNode: () => (position.nodeName ? { ...NODE, name: position.nodeName } : NODE),
		continueOnFail: () => options.continueOnFail ?? false,
		helpers: {
			...helpers,
			httpRequestWithAuthentication: async (
				credentialName: string,
				requestOptions: IHttpRequestOptions,
			) => await http.handle(credentialName, requestOptions),
		},
	} as unknown as IExecuteFunctions;
}

export function loadOptionsContext(http: MockHttp): ILoadOptionsFunctions {
	return {
		getNode: () => NODE,
		helpers: {
			httpRequestWithAuthentication: async (
				credentialName: string,
				requestOptions: IHttpRequestOptions,
			) => await http.handle(credentialName, requestOptions),
		},
	} as unknown as ILoadOptionsFunctions;
}

export const WEBHOOK_URL = 'https://n8n.example.com/webhook/abc-123/webhook';

export function hookContext(
	parameters: IDataObject,
	staticData: IDataObject,
	http: MockHttp,
	webhookUrl = WEBHOOK_URL,
): IHookFunctions {
	return {
		getNode: () => ({ ...NODE, name: 'Shorty Trigger', type: 'n8n-nodes-shorty.shortyTrigger' }),
		getNodeParameter: function (name: string, fallback?: unknown) {
			return getParameter(parameters, name, fallback, undefined, arguments.length > 1);
		},
		getNodeWebhookUrl: () => webhookUrl,
		getWorkflow: () => ({ id: 'wf-1', name: 'Daily digest', active: true }),
		getWorkflowStaticData: () => staticData,
		helpers: {
			httpRequestWithAuthentication: async (
				credentialName: string,
				requestOptions: IHttpRequestOptions,
			) => await http.handle(credentialName, requestOptions),
		},
	} as unknown as IHookFunctions;
}

export interface WebhookResponseRecorder {
	statusCode?: number;
	body?: unknown;
}

export function webhookContext(options: {
	parameters: IDataObject;
	staticData: IDataObject;
	headers: IDataObject;
	rawBody: string;
	http: MockHttp;
	recorder: WebhookResponseRecorder;
}): IWebhookFunctions {
	const response = {
		status(code: number) {
			options.recorder.statusCode = code;
			return response;
		},
		json(body: unknown) {
			options.recorder.body = body;
			return response;
		},
		send(body: unknown) {
			options.recorder.body = body;
			return response;
		},
		end() {
			return response;
		},
	};
	return {
		getNode: () => ({ ...NODE, name: 'Shorty Trigger', type: 'n8n-nodes-shorty.shortyTrigger' }),
		getNodeParameter: function (name: string, fallback?: unknown) {
			return getParameter(options.parameters, name, fallback, undefined, arguments.length > 1);
		},
		getWorkflowStaticData: () => options.staticData,
		getRequestObject: () => ({ rawBody: Buffer.from(options.rawBody, 'utf8') }),
		getResponseObject: () => response,
		getHeaderData: () => options.headers,
		getBodyData: () => JSON.parse(options.rawBody) as IDataObject,
		helpers: {
			...helpers,
			httpRequestWithAuthentication: async (
				credentialName: string,
				requestOptions: IHttpRequestOptions,
			) => await options.http.handle(credentialName, requestOptions),
		},
	} as unknown as IWebhookFunctions;
}

/** Runs a promise that must reject and returns its error. */
export async function rejection(promise: Promise<unknown>): Promise<Error & IDataObject> {
	try {
		await promise;
	} catch (error) {
		return error as Error & IDataObject;
	}
	throw new Error('Expected the call to fail, but it succeeded');
}

/** An article as GET /v1/articles/{id} answers it. */
export function sampleArticle(overrides: IDataObject = {}): IDataObject {
	return {
		id: 'art_1',
		title: 'Example Domain',
		description: 'A page reserved for documentation examples.',
		article_type: 'WEBPAGE_ARTICLE',
		source_url: 'https://example.com',
		created_at: '2026-11-04T10:00:00.000Z',
		summary: {
			parts: [
				{ title: 'Key points', content: 'The domain is reserved for examples.' },
				{ title: null, content: 'No permission is needed to use it.' },
			],
		},
		body_text: 'Example Domain. This domain is for use in illustrative examples.',
		...overrides,
	};
}

/** A job as GET /v1/jobs/{id} answers it. */
export function sampleJob(overrides: IDataObject = {}): IDataObject {
	return {
		jobId: 'job_1',
		status: 'success',
		output: { jobType: 'CONTENT_SUMMARY', title: 'Example Domain', outputId: 'art_1' },
		...overrides,
	};
}

/** A transcription as GET /v1/transcriptions/{id} answers it. */
export function sampleTranscription(overrides: IDataObject = {}): IDataObject {
	return {
		id: 'tr_1',
		status: 'SUCCESS',
		progress: 100,
		model_type: 'WHISPER_BASE',
		language: 'english',
		input_file: 'https://example.com/episode.mp3',
		error: null,
		output_language: null,
		translation_status: null,
		created_at: '2026-11-04T10:00:00.000Z',
		output_text: 'Welcome to the show.',
		translated_output_text: null,
		translation_progress: null,
		...overrides,
	};
}
