import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { downloadMedia } from "./media.js";

const VIEWER_DIR = fileURLToPath(new URL("./viewer", import.meta.url));

function humanSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function copyViewer(outDir, profile, name) {
	const tpl = await readFile(join(VIEWER_DIR, "index.html"), "utf8");
	const html = tpl
		.replaceAll("__TITLE__", `${name} archive`)
		.replaceAll("__TITLESUFFIX__", "archive")
		.replaceAll("__FOLDER__", profile.folder);
	await writeFile(join(outDir, "index.html"), html);
	for (const f of ["view.js", "view.css", "search.js"]) {
		await copyFile(join(VIEWER_DIR, f), join(outDir, f));
	}
	await mkdir(join(outDir, "assets", "fonts"), { recursive: true });
	for (const f of ["chirp.woff2", "chirpbold.woff2", "chirpheavy.woff2"]) {
		await copyFile(join(VIEWER_DIR, "assets", "fonts", f), join(outDir, "assets", "fonts", f));
	}
}

async function* walk(dir) {
	for (const ent of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, ent.name);
		if (ent.isDirectory()) yield* walk(full);
		else yield full;
	}
}

const STORE_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|woff2|zip)$/i;

async function zipDir(dir, outFile) {
	const out = createWriteStream(outFile);
	const files = [];
	for await (const f of walk(dir)) files.push(f);

	await new Promise((resolve, reject) => {
		out.on("error", reject);
		const zip = new Zip((err, chunk, final) => {
			if (err) return reject(err);
			out.write(chunk);
			if (final) out.end(resolve);
		});

		(async () => {
			for (const abs of files) {
				const name = relative(dir, abs).split(/[\\/]/).join("/");
				const bytes = new Uint8Array(await readFile(abs));
				const file = STORE_EXT.test(name)
					? new ZipPassThrough(name)
					: new ZipDeflate(name, { level: 6 });
				zip.add(file);
				file.push(bytes, true);
			}
			zip.end();
		})().catch(reject);
	});
}

export async function writeExport(
	{ acc, profile, ownerCount },
	outDir,
	{ zip = false, concurrency = 12 } = {},
) {
	const folderDir = join(outDir, acc.folder);
	await mkdir(folderDir, { recursive: true });

	const tweets = [...acc.tweets.values()];
	const users = [...acc.users.values()];
	const tweetsJson = JSON.stringify(tweets);
	const usersJson = JSON.stringify(users);

	await writeFile(join(folderDir, "tweets.json"), tweetsJson);
	await writeFile(join(folderDir, "users.json"), usersJson);
	await writeFile(join(folderDir, "cards.json"), JSON.stringify(acc.cards));

	profile.tweets_size = humanSize(Buffer.byteLength(tweetsJson));
	profile.users_size = humanSize(Buffer.byteLength(usersJson));
	if (!profile.posts) profile.posts = ownerCount;

	await writeFile(join(outDir, "profiles.json"), JSON.stringify({ profiles: [profile] }, null, 1));
	await copyViewer(outDir, profile, profile.name || profile.handle);

	const result = await downloadMedia(acc.media, outDir, { concurrency });

	if (zip) {
		const zipPath = `${outDir.replace(/\/+$/, "")}.zip`;
		await zipDir(outDir, zipPath);
		result.zip = zipPath;
	}
	return result;
}
