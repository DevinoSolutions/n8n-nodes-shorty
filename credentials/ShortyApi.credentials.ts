import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ShortyApi implements ICredentialType {
	name = 'shortyApi';

	displayName = 'Shorty API';

	icon: Icon = { light: 'file:../icons/shorty.svg', dark: 'file:../icons/shorty.dark.svg' };

	documentationUrl =
		'https://github.com/DevinoSolutions/n8n-nodes-shorty?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'shk_live_...',
			description:
				'A Shorty API key from Settings > API Keys (https://aishorty.com/settings?tab=api-keys). The connection test reads your plan and usage, so the key needs the usage:read scope.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://aishorty.com',
			url: '/v1/usage',
			method: 'GET',
		},
	};
}
