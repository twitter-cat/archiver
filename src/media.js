import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProgressBar } from "./progress.js";

async function fetchBytes(url, headers, attempts = 3) {
	let lastErr;
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url, { headers });
			if (res.status === 404 || res.status === 403) return null;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return new Uint8Array(await res.arrayBuffer());
		} catch (err) {
			lastErr = err;
			await new Promise((r) => setTimeout(r, 400 * (i + 1)));
		}
	}
	throw lastErr;
}

export async function downloadMedia(media, destRoot, { concurrency = 12 } = {}) {
	const entries = [...media.entries()];
	if (!entries.length) return { ok: 0, fail: 0, missing: 0 };
	const bar = new ProgressBar(entries.length, { label: "media" });
	let ok = 0;
	let fail = 0;
	let missing = 0;
	let cursor = 0;

	const worker = async () => {
		while (cursor < entries.length) {
			const [rel, { remote, headers }] = entries[cursor++];
			try {
				const bytes = await fetchBytes(remote, headers);
				if (!bytes) {
					missing++;
				} else {
					const abs = join(destRoot, rel);
					await mkdir(dirname(abs), { recursive: true });
					await writeFile(abs, bytes);
					ok++;
				}
			} catch {
				fail++;
			}
			bar.tick();
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
	bar.finish();
	return { ok, fail, missing };
}
