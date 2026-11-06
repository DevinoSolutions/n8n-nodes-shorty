// Reads the output of `n8n execute` and fails unless both Shorty nodes ran without an error.
// Prints node names, item counts and field names only: the values are account data.
import { readFileSync } from 'node:fs';

const text = readFileSync(process.argv[2], 'utf8');
const start = text.indexOf('{');
if (start < 0) {
	console.error('no JSON in the n8n output');
	process.exit(1);
}
const result = JSON.parse(text.slice(start));
const runData = result.data?.resultData?.runData ?? result.resultData?.runData ?? result.runData;
if (!runData) {
	console.error('no runData in the n8n output; top-level keys:', Object.keys(result).join(', '));
	process.exit(1);
}

let failed = false;
for (const name of ['Usage', 'Summaries']) {
	const run = runData[name]?.[0];
	if (!run) {
		console.error(`${name}: did not run`);
		failed = true;
		continue;
	}
	if (run.error) {
		console.error(`${name}: error ${run.error.message ?? ''} ${run.error.description ?? ''}`.trim());
		failed = true;
		continue;
	}
	const items = run.data?.main?.[0] ?? [];
	const keys = [...new Set(items.flatMap((item) => Object.keys(item.json ?? {})))].sort();
	console.log(`${name}: ${items.length} item(s), fields: ${keys.join(', ')}`);
	if (name === 'Usage' && items.length !== 1) failed = true;
}
process.exit(failed ? 1 : 0);
