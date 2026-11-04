import type { INodeProperties } from 'n8n-workflow';
import {
	DEDUPLICATION_KEY,
	ID_PLACEHOLDER,
	LANGUAGE,
	paginationFields,
	waitFields,
} from './common';

const showForCreate = { resource: ['transcription'], operation: ['create'] };
const showForGet = { resource: ['transcription'], operation: ['get'] };
const showForGetAll = { resource: ['transcription'], operation: ['getAll'] };

/** CreateTranscriptionBody `output_language`, as ISO 639-1 codes. */
export const OUTPUT_LANGUAGES = [
	{ name: 'Arabic', value: 'ar' },
	{ name: 'Bengali', value: 'bn' },
	{ name: 'Chinese', value: 'zh' },
	{ name: 'Czech', value: 'cs' },
	{ name: 'Danish', value: 'da' },
	{ name: 'Dutch', value: 'nl' },
	{ name: 'English', value: 'en' },
	{ name: 'Finnish', value: 'fi' },
	{ name: 'French', value: 'fr' },
	{ name: 'German', value: 'de' },
	{ name: 'Greek', value: 'el' },
	{ name: 'Hebrew', value: 'he' },
	{ name: 'Hindi', value: 'hi' },
	{ name: 'Hungarian', value: 'hu' },
	{ name: 'Indonesian', value: 'id' },
	{ name: 'Italian', value: 'it' },
	{ name: 'Japanese', value: 'ja' },
	{ name: 'Korean', value: 'ko' },
	{ name: 'Malay', value: 'ms' },
	{ name: 'Norwegian', value: 'no' },
	{ name: 'Polish', value: 'pl' },
	{ name: 'Portuguese', value: 'pt' },
	{ name: 'Romanian', value: 'ro' },
	{ name: 'Russian', value: 'ru' },
	{ name: 'Spanish', value: 'es' },
	{ name: 'Swedish', value: 'sv' },
	{ name: 'Thai', value: 'th' },
	{ name: 'Turkish', value: 'tr' },
	{ name: 'Ukrainian', value: 'uk' },
	{ name: 'Vietnamese', value: 'vi' },
];

export const transcriptionOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['transcription'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			action: 'Get a transcription',
			description: 'Get a transcription with its transcript text',
		},
		{
			name: 'Get Many',
			value: 'getAll',
			action: 'Get many transcriptions',
			description: 'List your transcriptions, newest first',
		},
		{
			name: 'Transcribe',
			value: 'create',
			action: 'Transcribe an audio or video URL',
			description: 'Transcribe an audio or video link, such as a podcast episode',
		},
	],
	default: 'create',
};

export const transcriptionFields: INodeProperties[] = [
	{
		displayName: 'Media URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/podcast.mp3',
		description: 'A link to the audio or video file to transcribe',
		displayOptions: { show: showForCreate },
	},
	...waitFields(showForCreate, {
		waitDefault: true,
		timeoutDefault: 600,
		what: 'the finished transcript',
	}),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showForCreate },
		options: [
			DEDUPLICATION_KEY,
			{ ...LANGUAGE, description: `The language spoken in the media. ${LANGUAGE.description}.` },
			{
				displayName: 'Output Language',
				name: 'outputLanguage',
				type: 'options',
				default: 'en',
				options: OUTPUT_LANGUAGES,
				description:
					'The language to deliver the transcript in. English is free; any other language is a translation of the finished transcript and needs Shorty Premium.',
			},
		],
	},
	{
		displayName: 'Transcription ID',
		name: 'transcriptionId',
		type: 'string',
		required: true,
		default: '',
		placeholder: ID_PLACEHOLDER,
		description: 'The ID of the transcription, as returned by Transcribe or Get Many',
		displayOptions: { show: showForGet },
	},
	...paginationFields(showForGetAll),
];
