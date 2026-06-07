#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AccountPool, loadTokens } from "./accounts.js";
import { writeExport } from "./export.js";
import { extractProfile } from "./extract.js";
import { c, sym } from "./ui.js";

function help() {
	const opt = (flag, desc) => `  ${c.brand(flag.padEnd(24))} ${c.dim(desc)}`;
	return [
		`${c.title("usage")}  ${c.dim("bunx archive-twitter")} ${c.brand("<handle...>")} ${c.dim("[options]")}`,
		"",
		c.title("options"),
		opt("--token <auth_token>", "auth_token cookie value. repeatable to cycle"),
		opt("", "accounts and spread rate limits."),
		opt("--tokens-file <path>", "file with one auth_token per line (or sep)."),
		opt("--out <dir>", "output directory. default: <handle>-archive"),
		opt("--zip", "also produce a <out>.zip alongside the folder."),
		opt("--client <name>", "emusks client to emulate. default: web."),
		opt("--endpoint <name>", "graphql endpoint: web | main | tweetdeck | ..."),
		opt("--concurrency <n>", "parallel media downloads. default: 12."),
		opt("-h, --help", "show this help."),
		"",
		`${sym.dot} tokens can also come from the ${c.brand("ARCHIVER_TOKENS")} env var.`,
		"",
		c.title("examples"),
		`  ${c.dim("bunx archive-twitter")} ${c.brand("tommyinnit")} ${c.dim("--token AAA --token BBB --zip")}`,
		`  ${c.dim('ARCHIVER_TOKENS="AAA,BBB" bunx archive-twitter')} ${c.brand("jack")} ${c.dim("--out ./archives")}`,
		"",
	].join("\n");
}

function fail(msg) {
	console.error(`\n${sym.err} ${c.err(msg)}\n`);
	console.error(c.dim("run with --help for usage."));
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
		console.log(help());
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
	console.log(c.dim(`logging in ${tokens.length} account${tokens.length === 1 ? "" : "s"}...`));
	try {
		await pool.login(tokens, {
			onStatus: (s) => {
				const bad = /fail|error|denied/i.test(s);
				console.log(`  ${bad ? sym.err : sym.ok} ${c.dim(s)}`);
			},
		});
	} catch (err) {
		fail(err.message);
	}
	console.log(
		`${sym.ok} ${c.brand(pool.healthy)} ${c.dim(`account${pool.healthy === 1 ? "" : "s"} ready`)}\n`,
	);

	for (const handle of handles) {
		const outDir = resolve(
			handles.length === 1 && values.out
				? values.out
				: `${values.out ? `${values.out}/` : ""}${handle.toLowerCase()}-archive`,
		);
		try {
			const result = await extractProfile(pool, handle, {
				onLog: (m) => console.log(`${sym.info} ${c.dim(m)}`),
			});
			const dl = await writeExport(result, outDir, { zip: values.zip, concurrency });
			const bits = [c.ok(`${dl.ok} media saved`)];
			if (dl.missing) bits.push(c.warn(`${dl.missing} gone`));
			if (dl.fail) bits.push(c.err(`${dl.fail} failed`));
			console.log(`\n${sym.ok} ${c.title("archived")} ${c.brand(outDir)}`);
			console.log(`  ${bits.join(` ${sym.dot} `)}`);
			if (dl.zip) console.log(`  ${c.dim("zip")} ${sym.arrow} ${c.brand(dl.zip)}`);

			process.exit(0);
		} catch (err) {
			console.error(`\n${sym.err} ${c.err(`failed to archive @${handle}: ${err.message}`)}\n`);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error(`\n${sym.err} ${c.err(err?.stack || err)}`);
	process.exit(1);
});
