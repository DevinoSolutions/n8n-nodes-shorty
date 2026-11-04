import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { ShortyApi } from '../credentials/ShortyApi.credentials';
import { MockHttp } from './helpers';

const credential = new ShortyApi();

/** Resolves the credential's `={{$credentials.x}}` header expressions the way n8n does. */
function authHeaders(apiKey: string): IDataObject {
	const headers = (credential.authenticate.properties.headers ?? {}) as IDataObject;
	return Object.fromEntries(
		Object.entries(headers).map(([name, template]) => [
			name,
			String(template).replace(/^=/, '').replace('{{$credentials.apiKey}}', apiKey),
		]),
	);
}

/** n8n's credential test: the `test` request, with the credential's auth applied. */
async function runCredentialTest(http: MockHttp, apiKey: string): Promise<boolean> {
	const request = credential.test.request;
	const response = await http.handle('shortyApi', {
		method: request.method,
		url: `${String(request.baseURL)}${String(request.url)}`,
		headers: authHeaders(apiKey),
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	});
	return response.statusCode < 400;
}

describe('Shorty API credential', () => {
	it('is named shortyApi and stores one password-masked API key', () => {
		assert.strictEqual(credential.name, 'shortyApi');
		assert.strictEqual(credential.properties.length, 1);
		const [apiKey] = credential.properties;
		assert.strictEqual(apiKey.name, 'apiKey');
		assert.strictEqual(apiKey.required, true);
		assert.deepEqual(apiKey.typeOptions, { password: true });
	});

	it('sends the key as a Bearer token, the header the /v1 OpenAPI document declares', () => {
		assert.deepEqual(authHeaders('shk_live_example'), {
			Authorization: 'Bearer shk_live_example',
		});
	});

	it('tests the connection with GET https://aishorty.com/v1/usage, which costs no quota', async () => {
		const http = new MockHttp([{ statusCode: 200, body: { plan: { tier: 'free' } } }]);
		assert.strictEqual(await runCredentialTest(http, 'shk_live_example'), true);
		assert.strictEqual(http.calls.length, 1);
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, 'https://aishorty.com/v1/usage');
		assert.strictEqual(http.calls[0].headers.Authorization, 'Bearer shk_live_example');
	});

	it('fails the connection test for a revoked key (401 invalid_api_key)', async () => {
		const http = new MockHttp([{ statusCode: 401, body: { code: 'invalid_api_key' } }]);
		assert.strictEqual(await runCredentialTest(http, 'shk_live_revoked'), false);
	});

	it('fails the connection test for a key without usage:read (403 insufficient_scope)', async () => {
		const http = new MockHttp([{ statusCode: 403, body: { code: 'insufficient_scope' } }]);
		assert.strictEqual(await runCredentialTest(http, 'shk_live_jobs_only'), false);
	});
});
