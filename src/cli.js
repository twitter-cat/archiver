#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AccountPool, loadTokens } from "./accounts.js";
import { writeExport } from "./export.js";
import { extractProfile } from "./extract.js";

const HELP = `tcat-archive — archive a twitter/x profile into a self-contained html viewer

usage:
  tcat-archive <handle...> [options]

options:
  --token <auth_token>      an auth_token cookie value. repeatable for multiple
                            accounts (they're cycled to spread rate limits).
  --tokens-file <path>      file with one auth_token per line (or comma/space sep).
  --out <dir>               output directory. default: <handle>-archive
  --zip                     also produce a <out>.zip alongside the folder.
  --client <name>           emusks client to emulate (e.g. tweetdeck). default: web.
  --endpoint <name>         graphql endpoint: web | main | tweetdeck | ...
  --concurrency <n>         parallel media downloads. default: 12.
  -h, --help                show this help.

tokens can also come from the ARCHIVER_TOKENS env var (comma/space separated).

example:
  tcat-archive tommyinnit --token AAA --token BBB --zip
  ARCHIVER_TOKENS="AAA,BBB" tcat-archive jack dril --out ./archives

view it by serving the output folder over http (browsers block file://):
  cd <out> && bunx serve`;

function fail(msg) {
	console.error(`error: ${msg}\n`);
	console.error("run with --help for usage.");
	process.exit(1);
}

async function main() {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: {
				token: { type: "string", multiple: true },
				"tokens-file": { type: "string" },
				out: { type: "string" },
				zip: { type: "boolean" },
				client: { type: "string" },
				endpoint: { type: "string" },
				concurrency: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (err) {
		fail(err.message);
	}

	const { values, positionals } = parsed;
	if (values.help || positionals.length === 0) {
		console.log(HELP);
		process.exit(values.help ? 0 : 1);
	}

	const handles = positionals.map((h) => h.replace(/^@/, "").trim()).filter(Boolean);
	const concurrency = Math.max(1, Number(values.concurrency) || 12);

	const tokens = await loadTokens({
		tokens: values.token ?? [],
		tokensFile: values["tokens-file"],
	});
	if (!tokens.length) {
		fail("no auth tokens provided. pass --token, --tokens-file, or set ARCHIVER_TOKENS.");
	}

	const pool = new AccountPool({ client: values.client, endpoint: values.endpoint });
	console.log(`logging in ${tokens.length} account${tokens.length === 1 ? "" : "s"}…`);
	try {
		await pool.login(tokens, { onStatus: (s) => console.log(`  ${s}`) });
	} catch (err) {
		fail(err.message);
	}
	console.log(`${pool.healthy} account${pool.healthy === 1 ? "" : "s"} ready.\n`);

	for (const handle of handles) {
		const outDir = resolve(
			handles.length === 1 && values.out
				? values.out
				: `${values.out ? `${values.out}/` : ""}${handle.toLowerCase()}-archive`,
		);
		try {
			const result = await extractProfile(pool, handle, { onLog: (m) => console.log(m) });
			const dl = await writeExport(result, outDir, { zip: values.zip, concurrency });
			const bits = [`${dl.ok} media saved`];
			if (dl.missing) bits.push(`${dl.missing} gone`);
			if (dl.fail) bits.push(`${dl.fail} failed`);
			console.log(`done: ${outDir}  (${bits.join(", ")})`);
			if (dl.zip) console.log(`zip:  ${dl.zip}`);

			process.exit(0);
		} catch (err) {
			console.error(`failed to archive @${handle}: ${err.message}\n`);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
