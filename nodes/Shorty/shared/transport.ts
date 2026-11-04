import {
	NodeApiError,
	type IDataObject,
	type IExecuteFunctions,
	type IHookFunctions,
	type IHttpRequestMethods,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type IN8nHttpFullResponse,
	type IWebhookFunctions,
	type JsonObject,
} from 'n8n-workflow';

/**
 * Shorty's public REST API (https://aishorty.com/docs/api). Every path starts with `/v1`, and
 * every call acts on the account the API key belongs to.
 */
export const API_BASE_URL = 'https://aishorty.com';

/** Where a user creates API keys. */
export const API_KEYS_SETTINGS =
	'Shorty under Settings > API Keys (https://aishorty.com/settings?tab=api-keys)';

export type ShortyContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

export interface ShortyRequest {
	method: IHttpRequestMethods;
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
	headers?: IDataObject;
}

export interface ShortyResponse<T = unknown> {
	statusCode: number;
	body: T;
	headers: IDataObject;
}

/**
 * One request with the Shorty credential, answering the status, headers and body of every
 * response, error statuses included. Callers that need to branch on a status (200 vs 202 on a
 * summary, a retryable 5xx, 404 on delete) use this; everything else uses `shortyApiRequest`.
 */
export async function shortyRequest<T = unknown>(
	this: ShortyContext,
	request: ShortyRequest,
): Promise<ShortyResponse<T>> {
	const options: IHttpRequestOptions = {
		method: request.method,
		url: `${API_BASE_URL}${request.path}`,
		headers: { Accept: 'application/json', ...(request.headers ?? {}) },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (request.qs && Object.keys(request.qs).length > 0) {
		options.qs = request.qs;
	}
	if (request.body !== undefined) {
		options.body = request.body;
	}

	const response = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'shortyApi',
		options,
	)) as IN8nHttpFullResponse;

	return {
		statusCode: response.statusCode,
		body: parseBody(response.body) as T,
		headers: (response.headers ?? {}) as IDataObject,
	};
}

/** Like `shortyRequest`, but throws a readable `NodeApiError` for any error status. */
export async function shortyApiRequest(
	this: ShortyContext,
	request: ShortyRequest,
	itemIndex?: number,
	context?: string,
): Promise<IDataObject> {
	const response = (await shortyRequest.call(this, request)) as ShortyResponse<IDataObject>;
	if (response.statusCode >= 400) {
		throwApiError.call(this, response, context, itemIndex);
	}
	return response.body;
}

function parseBody(body: unknown): unknown {
	if (typeof body === 'string' && body.trim() !== '') {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	return body;
}

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

/** One error, read from the RFC 9457 problem body every `/v1` error carries. */
export interface ApiErrorDetails {
	code?: string;
	message?: string;
	requestId?: string;
	fieldErrors: string[];
}

interface ProblemBody {
	code?: string;
	title?: string;
	detail?: string;
	request_id?: string;
	errors?: Array<{ pointer?: string; message?: string }>;
}

export function readApiError(body: unknown): ApiErrorDetails {
	const problem = (typeof body === 'object' && body !== null ? body : {}) as ProblemBody;
	return {
		code: typeof problem.code === 'string' ? problem.code.toLowerCase() : undefined,
		message:
			problem.detail ??
			problem.title ??
			(typeof body === 'string' && body.trim() !== '' ? body.slice(0, 300) : undefined),
		requestId: problem.request_id,
		fieldErrors: (problem.errors ?? [])
			.map((entry) => [entry.pointer, entry.message].filter(Boolean).join(': '))
			.filter((line) => line.length > 0),
	};
}

/**
 * Throws the error a failed response deserves: what went wrong in Shorty's own words, what to do
 * about it, and the request ID support needs.
 */
export function throwApiError(
	this: ShortyContext,
	response: ShortyResponse<unknown>,
	context?: string,
	itemIndex?: number,
): never {
	const error = readApiError(response.body);
	const headline = error.message ?? `Shorty answered HTTP ${response.statusCode}`;
	const message = [context, headline].filter(Boolean).join(' ');
	const trace = error.requestId ? ` Request ID: ${error.requestId}.` : '';
	const fields = error.fieldErrors.length > 0 ? ` ${error.fieldErrors.join('; ')}.` : '';

	let hint = '';
	if (response.statusCode === 401) {
		hint = `Check the credential: it needs a valid Shorty API key (shk_live_...) from ${API_KEYS_SETTINGS}.`;
	} else if (error.code === 'insufficient_scope') {
		hint = `The API key is missing a permission this operation needs. Create a Full access key, or a key with the scopes listed in the node's README, in ${API_KEYS_SETTINGS}.`;
	} else if (error.code === 'feature_not_enabled') {
		hint = "The account's Shorty plan does not include this. Check the plan in Shorty.";
	} else if (error.code === 'quota_exhausted') {
		hint =
			"The account has used its plan's allowance for this. Retrying will not help until the allowance resets or the plan is upgraded.";
	} else if (response.statusCode === 429) {
		const retryAfter = response.headers['retry-after'];
		hint = `Shorty rate-limited this request.${
			retryAfter ? ` Retry after ${String(retryAfter)} seconds.` : ''
		} Enable Retry On Fail on the node, or slow the workflow down.`;
	}

	const description = `${hint}${fields}${trace}`.trim();
	const errorBody: JsonObject =
		typeof response.body === 'object' && response.body !== null
			? (response.body as JsonObject)
			: { message: headline };

	throw new NodeApiError(this.getNode(), errorBody, {
		message,
		description: description || undefined,
		httpCode: String(response.statusCode),
		itemIndex,
	});
}
