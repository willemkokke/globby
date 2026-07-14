import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {globby as baseline} from '@globby/main-branch';
import {globby as prototype} from './index.js';

// A repository with a large gitignored directory, e.g. a mounted network share.
const DIRECTORIES = 400;
const FILES_PER_DIRECTORY = 25;
const MOUNT = 'mount';

const repo = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'globby-bench-')));
fs.mkdirSync(path.join(repo, '.git'));
fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
for (let i = 0; i < 50; i++) {
	fs.writeFileSync(path.join(repo, 'src', `file${i}.js`), '');
}

let shareFiles = 0;
for (let d = 0; d < DIRECTORIES; d++) {
	const dir = path.join(repo, MOUNT, `d${d}`);
	fs.mkdirSync(dir, {recursive: true});
	for (let f = 0; f < FILES_PER_DIRECTORY; f++) {
		fs.writeFileSync(path.join(dir, `f${f}.js`), '');
		shareFiles++;
	}
}

const mountRoot = path.join(repo, MOUNT);
const mountPrefix = mountRoot + path.sep;
const inMount = p => {
	const s = path.resolve(p.toString());
	return s === mountRoot || s.startsWith(mountPrefix);
};

// `latencyMs` emulates a network share: every directory read costs a round-trip.
const makeFs = (latencyMs, stats) => ({
	...fs,
	readdir(...args) {
		const callback = args.at(-1);
		stats.total++;
		if (inMount(args[0])) {
			stats.mount++;
		}

		const rest = args.slice(0, -1);
		const done = (...r) => (latencyMs > 0 ? setTimeout(() => callback(...r), latencyMs) : callback(...r));
		// eslint-disable-next-line n/prefer-promises/fs -- fast-glob uses the callback API, which is what needs instrumenting.
		return fs.readdir(...rest, done);
	},
});

const run = async (implementation, gitignore, latencyMs) => {
	fs.writeFileSync(path.join(repo, '.gitignore'), gitignore);
	const stats = {mount: 0, total: 0};
	const start = performance.now();
	const result = await implementation(['**/*.js'], {cwd: repo, gitignore: true, fs: makeFs(latencyMs, stats)});
	return {ms: performance.now() - start, stats, files: [...result].sort()};
};

const sameResults = (a, b) => a.files.length === b.files.length && a.files.every((file, index) => file === b.files[index]);

const scenarios = [
	['clean .gitignore', `${MOUNT}/\n`],
	['.gitignore with a negation', `${MOUNT}/\n*.log\n!keep.log\n`],
];

console.log(`repo: ${shareFiles} files in ${DIRECTORIES} dirs under ${MOUNT}/ (gitignored) + 50 src files\n`);

for (const latencyMs of [0, 1]) {
	console.log(latencyMs === 0 ? '### local disk (no added latency)' : `### simulated network share (${latencyMs}ms per directory read)`);
	console.log('scenario                      impl        readdirs in share   total readdirs      time');
	console.log('-'.repeat(90));
	for (const [label, gitignore] of scenarios) {
		/* eslint-disable no-await-in-loop */
		const before = await run(baseline, gitignore, latencyMs);
		const after = await run(prototype, gitignore, latencyMs);
		/* eslint-enable no-await-in-loop */
		const row = (name, r) => `${label.padEnd(29)} ${name.padEnd(11)} ${String(r.stats.mount).padEnd(19)} ${String(r.stats.total).padEnd(19)} ${Math.round(r.ms)}ms`;
		console.log(row('main', before));
		console.log(row('prototype', after));
		const speedup = before.ms / after.ms;
		const saved = before.stats.mount - after.stats.mount;
		console.log(`${' '.repeat(30)}=> ${speedup.toFixed(1)}x faster, ${saved} fewer directory reads`);
		console.log(`${' '.repeat(30)}   results identical: ${sameResults(before, after)} (${after.files.length} files)\n`);
	}
}

fs.rmSync(repo, {recursive: true, force: true});
