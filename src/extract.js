import { ProgressBar, Spinner } from "./progress.js";
import { ingestPage, makeCollector, mapProfile, timelineCursor } from "./twitter.js";

function ymd(date) {
	const p = (n) => String(n).padStart(2, "0");
	return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`;
}

function ownerCount(acc) {
	let n = 0;
	for (const t of acc.tweets.values()) if (t.user_id === acc.ownerId) n++;
	return n;
}

function oldestOwnerDate(acc) {
	let min = Number.POSITIVE_INFINITY;
	for (const t of acc.tweets.values()) {
		if (t.user_id !== acc.ownerId) continue;
		const ts = Date.parse(t.created_at);
		if (!Number.isNaN(ts) && ts < min) min = ts;
	}
	return Number.isFinite(min) ? min : null;
}

function makeTracker(total, label) {
	if (total > 0) {
		const bar = new ProgressBar(total, { label });
		return { total, update: (done, note) => bar.setDone(done, note), stop: () => bar.finish() };
	}
	const sp = new Spinner(label);
	return { total: 0, update: (done, note) => sp.set(done, note), stop: () => sp.stop() };
}

async function drainCursor(
	pool,
	makeCall,
	acc,
	report,
	note,
	{ maxEmpty = 2, maxPages = 8000, target = 0 } = {},
) {
	let cursor = null;
	let empty = 0;
	let pages = 0;
	while (pages < maxPages) {
		const page = await pool.run((c) => makeCall(c, cursor), {
			onWait: (secs, w) => report(w || `waiting ${secs}s`),
		});
		pages++;
		const raw = page?.raw ?? page;
		const before = acc.tweets.size;
		ingestPage(acc, raw);
		report(note);
		if (target && ownerCount(acc) >= target) break;
		const next = page?.nextCursor ?? timelineCursor(raw, "bottom");
		if (acc.tweets.size === before) empty++;
		else empty = 0;
		if (!next || empty >= maxEmpty) break;
		cursor = next;
	}
	return pages;
}

async function searchBackfill(
	pool,
	handle,
	acc,
	report,
	{ target = 0, staleRounds = 3, maxRounds = 500 } = {},
) {
	let until = null;
	let stale = 0;
	for (let round = 0; round < maxRounds; round++) {
		if (target && ownerCount(acc) >= target) break;
		const q = until ? `from:${handle} until:${until}` : `from:${handle}`;
		const before = ownerCount(acc);
		await drainCursor(
			pool,
			(c, cursor) => c.search.latest(q, { cursor, count: 40 }),
			acc,
			report,
			`searching ${until ? `before ${until}` : "newest"}`,
			{ target },
		);
		if (ownerCount(acc) === before) {
			if (++stale >= staleRounds) break;
		} else {
			stale = 0;
		}
		const oldest = oldestOwnerDate(acc);
		if (oldest == null) break;
		const nextUntil = ymd(new Date(oldest));
		until = nextUntil === until ? ymd(new Date(oldest - 86_400_000)) : nextUntil;
	}
}

export async function extractProfile(pool, handle, { onLog } = {}) {
	onLog?.(`resolving @${handle}…`);
	const user = await pool.run((c) => c.users.getByUsername(handle));
	if (!user?.id) throw new Error(`could not resolve @${handle}`);

	const folder = handle.toLowerCase();
	const acc = makeCollector(folder, user.id);
	const profile = mapProfile(acc, user);
	const total = user.stats?.posts || 0;

	const tracker = makeTracker(total, `archiving @${handle}`);
	const report = (note) => tracker.update(ownerCount(acc), note);
	const reached = () => total > 0 && ownerCount(acc) >= total;

	try {
		await drainCursor(
			pool,
			(c, cursor) => c.users.tweets(user.id, { cursor, count: 100 }),
			acc,
			report,
			"scanning tweets",
			{ target: total },
		);
		if (!reached())
			await drainCursor(
				pool,
				(c, cursor) => c.users.replies(user.id, { cursor, count: 100 }),
				acc,
				report,
				"scanning replies",
				{ target: total },
			);
		if (!reached())
			await drainCursor(
				pool,
				(c, cursor) => c.users.userMedia(user.id, { cursor, count: 100 }),
				acc,
				report,
				"scanning media",
				{ target: total },
			);
		if (!reached()) await searchBackfill(pool, handle, acc, report, { target: total });
	} finally {
		tracker.stop();
	}

	const owner = ownerCount(acc);
	const gap =
		total && owner < total
			? ` (~${total - owner} unreachable: retweets, deleted, or beyond search)`
			: "";
	onLog?.(
		`@${handle}: ${owner}${total ? `/${total}` : ""} posts archived${gap}, ${acc.tweets.size} tweets total, ${acc.users.size} users, ${acc.media.size} media files`,
	);
	return { acc, profile, ownerCount: owner };
}
