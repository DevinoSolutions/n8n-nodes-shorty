import { assert, describe, it } from 'vitest';
import { articleLabel, searchSummaries, type Article } from '../nodes/Shorty/listSearch';
import { loadOptionsContext, MockHttp } from './helpers';

const article = (overrides: Partial<Article> = {}): Article => ({
	id: 'art_1',
	title: 'How transformers work',
	description: null,
	article_type: 'YOUTUBE_ARTICLE',
	source_url: 'https://www.youtube.com/watch?v=abc',
	created_at: '2026-11-04T10:00:00.000Z',
	...overrides,
});

describe('Summary dropdown', () => {
	it('labels a summary by its title, then its source, then its ID', () => {
		assert.strictEqual(articleLabel(article()), 'How transformers work');
		assert.strictEqual(
			articleLabel(article({ title: null })),
			'https://www.youtube.com/watch?v=abc',
		);
		assert.strictEqual(articleLabel(article({ title: ' ', source_url: null })), 'art_1');
		assert.strictEqual(articleLabel(article({ title: 'x'.repeat(100) })).length, 80);
	});

	it('pages through the library newest first without a filter', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { data: [article()], has_more: true, next_cursor: 'c2' } },
		]);
		const result = await searchSummaries.call(loadOptionsContext(http), undefined, 'c1');
		assert.strictEqual(http.calls[0].url, 'https://aishorty.com/v1/articles');
		assert.deepEqual(http.calls[0].qs, { limit: 50, cursor: 'c1' });
		assert.deepEqual(result, {
			results: [
				{
					name: 'How transformers work',
					value: 'art_1',
					url: 'https://aishorty.com/articles/art_1',
				},
			],
			paginationToken: 'c2',
		});
	});

	it('asks Shorty’s search when the user types a filter', async () => {
		const http = new MockHttp([{ statusCode: 200, body: { data: [article()], count: 1 } }]);
		const result = await searchSummaries.call(loadOptionsContext(http), ' transformers ');
		assert.strictEqual(http.calls[0].url, 'https://aishorty.com/v1/articles/search');
		assert.deepEqual(http.calls[0].qs, { q: 'transformers', limit: 20 });
		assert.strictEqual(result.results.length, 1);
		assert.strictEqual(result.paginationToken, undefined);
	});
});
