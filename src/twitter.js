const MEDIA_REFERER = { referer: "https://x.com/", origin: "https://x.com" };

export function makeCollector(folder, ownerId) {
	return {
		folder,
		ownerId,
		tweets: new Map(), // id -> viewer tweet
		users: new Map(), // id -> viewer user
		media: new Map(), // local path -> { remote, headers }
		cards: {}, // expanded url -> { title, description, image, site }
	};
}

function unwrap(result) {
	if (!result) return null;
	if (result.__typename === "TweetWithVisibilityResults") return result.tweet ?? null;
	if (result.tweet?.legacy) return result.tweet;
	return result;
}

function findInstructions(obj) {
	if (!obj || typeof obj !== "object") return null;
	if (Array.isArray(obj.instructions)) return obj.instructions;
	for (const key of Object.keys(obj)) {
		const val = obj[key];
		if (val && typeof val === "object") {
			const found = findInstructions(val);
			if (found) return found;
		}
	}
	return null;
}

export function timelineResults(raw) {
	const out = [];
	const instructions = findInstructions(raw?.data ?? raw);
	if (!instructions) return out;
	const pushEntry = (entry) => {
		const r =
			entry?.content?.itemContent?.tweet_results?.result ??
			entry?.item?.itemContent?.tweet_results?.result;
		if (r) out.push(r);
		for (const item of entry?.content?.items ?? []) {
			const ir = item?.item?.itemContent?.tweet_results?.result;
			if (ir) out.push(ir);
		}
	};
	for (const ins of instructions) {
		for (const entry of ins.entries ?? []) pushEntry(entry);
		if (ins.entry) pushEntry(ins.entry);
	}
	return out;
}

export function timelineCursor(raw, kind = "bottom") {
	const instructions = findInstructions(raw?.data ?? raw);
	if (!instructions) return null;
	for (const ins of instructions) {
		for (const entry of ins.entries ?? []) {
			if (entry.entryId?.includes(`cursor-${kind}`)) {
				return entry.content?.value ?? entry.content?.itemContent?.value ?? null;
			}
		}
	}
	return null;
}

function pickExt(url) {
	const clean = (url || "").split("?")[0];
	const m = clean.match(/\.([a-z0-9]+)$/i);
	return m ? m[1].toLowerCase() : "jpg";
}

function imageOrig(url) {
	if (!url) return url;

  if (/pbs\.twimg\.com\//.test(url) && !/name=/.test(url)) {
		return `${url}${url.includes("?") ? "&" : "?"}name=orig`;
	}
	return url;
}

function bestVideoVariant(media) {
	const variants = (media.video_info?.variants ?? []).filter((v) => v.content_type === "video/mp4");
	variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
	return variants[0]?.url ?? null;
}

function mapMedia(acc, legacy) {
	const list = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
	const out = [];
	for (const m of list) {
		const key = m.media_key ?? m.id_str ?? `${legacy?.id_str}-${out.length}`;
		if (m.type === "photo") {
			const ext = pickExt(m.media_url_https) === "png" ? "png" : "jpg";
			const path = `${acc.folder}/media/${key}.${ext}`;
			if (!acc.media.has(path))
				acc.media.set(path, { remote: imageOrig(m.media_url_https), headers: MEDIA_REFERER });
			out.push({ type: "photo", thumbnail: path });
			continue;
		}
		if (m.type === "video" || m.type === "animated_gif") {
			const videoUrl = bestVideoVariant(m);
			if (!videoUrl) continue;
			const posterPath = `${acc.folder}/media/${key}.jpg`;
			const videoPath = `${acc.folder}/media/${key}.mp4`;
			if (!acc.media.has(posterPath))
				acc.media.set(posterPath, { remote: m.media_url_https, headers: MEDIA_REFERER });
			if (!acc.media.has(videoPath))
				acc.media.set(videoPath, { remote: videoUrl, headers: MEDIA_REFERER });
			const item = { type: m.type, thumbnail: posterPath, video_url: videoPath };
			const dur = m.video_info?.duration_millis;
			if (dur) item.duration_ms = dur;
			out.push(item);
		}
	}
	return out;
}

function noteOf(result) {
	return result?.note_tweet?.note_tweet_results?.result ?? null;
}

function mapUrls(legacy, note) {
	const src = note?.entity_set?.urls ?? legacy?.entities?.urls ?? [];
	return src
		.filter((u) => u && (u.url || u.expanded_url))
		.map((u) => ({ short: u.url, expanded: u.expanded_url ?? u.url }));
}

function mapMentions(legacy, note) {
	const src = note?.entity_set?.user_mentions ?? legacy?.entities?.user_mentions ?? [];
	return src.map((m) => m.screen_name).filter(Boolean);
}

function cardBindings(card) {
	const map = {};
	for (const b of card?.legacy?.binding_values ?? card?.binding_values ?? []) {
		if (!b?.key) continue;
		map[b.key] = b.value;
	}
	return map;
}

function bakeCard(acc, result, urls) {
	const card = result?.card;
	if (!card) return;
	const linkUrl = (
		urls.find((u) => {
			try {
				const h = new URL(u.expanded).hostname.toLowerCase();
				return !/(^|\.)(x|twitter)\.com$/.test(h);
			} catch {
				return false;
			}
		}) || urls[0]
	)?.expanded;
	if (!linkUrl || acc.cards[linkUrl]) return;
	const b = cardBindings(card);
	const str = (k) => b[k]?.string_value || "";
	const img = (...keys) => {
		for (const k of keys) {
			const v = b[k]?.image_value?.url;
			if (v) return v;
		}
		return "";
	};
	const meta = {
		title: str("title"),
		description: str("description"),
		image: img(
			"summary_photo_image_original",
			"summary_photo_image_large",
			"thumbnail_image_original",
			"thumbnail_image_large",
			"photo_image_full_size_original",
			"player_image_original",
		),
		site: str("vanity_url") || str("domain"),
	};
	if (meta.title || meta.image) acc.cards[linkUrl] = meta;
}

function fullPfp(url) {
	return url ? url.replace("_normal", "") : url;
}

function plainLocation(loc) {
	if (!loc) return "";
	if (typeof loc === "string") return loc;
	return typeof loc.location === "string" ? loc.location : "";
}

function ensureUser(acc, rawUser) {
	const u = unwrapUser(rawUser);
	if (!u) return null;
	const id = u.rest_id ?? u.legacy?.id_str ?? u.id_str;
	if (!id) return null;
	if (acc.users.has(id)) return id;
	const legacy = u.legacy ?? {};
	const core = u.core ?? {};
	const username = core.screen_name ?? legacy.screen_name ?? "";
	const avatarRemote = fullPfp(u.avatar?.image_url ?? legacy.profile_image_url_https ?? "");
	let avatarPath = "";
	if (avatarRemote) {
		avatarPath = `${acc.folder}/pfps/${id}.jpg`;
		if (!acc.media.has(avatarPath))
			acc.media.set(avatarPath, { remote: avatarRemote, headers: MEDIA_REFERER });
	}
	const urlEntity = legacy.entities?.url?.urls?.[0];
	acc.users.set(id, {
		id,
		username,
		display_name: core.name ?? legacy.name ?? "",
		avatar: avatarPath,
		verified: !!(u.is_blue_verified || u.verification?.verified || legacy.verified),
		bio: legacy.description ?? "",
		location: plainLocation(u.location) || plainLocation(legacy.location),
		url: legacy.url ?? urlEntity?.url ?? "",
		url_expanded: urlEntity?.expanded_url ?? "",
		followers: legacy.followers_count ?? 0,
		following: legacy.friends_count ?? 0,
		posts: legacy.statuses_count ?? 0,
	});
	return id;
}

function unwrapUser(rawUser) {
	if (!rawUser) return null;
	if (rawUser.user_results?.result) return rawUser.user_results.result;
	if (rawUser.result) return rawUser.result;
	return rawUser;
}

export function ingestTweet(acc, rawResult, { skipRetweets = true } = {}) {
	const result = unwrap(rawResult);
	const legacy = result?.legacy;
	if (!result || !legacy) return null;

	if (skipRetweets && legacy.retweeted_status_result) return null;

	const id = legacy.id_str ?? result.rest_id;
	if (!id) return null;

	const userId = ensureUser(acc, result.core?.user_results) ?? legacy.user_id_str ?? "";
	const note = noteOf(result);
	const urls = mapUrls(legacy, note);

	const tweet = {
		id,
		user_id: userId,
		created_at: legacy.created_at,
		text: note?.text ?? legacy.full_text ?? "",
		likes: legacy.favorite_count ?? 0,
		retweets: legacy.retweet_count ?? 0,
		replies: legacy.reply_count ?? 0,
		quotes: legacy.quote_count ?? 0,
		bookmarks: legacy.bookmark_count ?? 0,
		views: Number(result.views?.count) || 0,
		lang: legacy.lang ?? "",
		media: mapMedia(acc, legacy),
		urls,
		mentions: mapMentions(legacy, note),
	};

	if (legacy.in_reply_to_status_id_str) {
		tweet.in_reply_to = {
			status_id: legacy.in_reply_to_status_id_str,
			screen_name: legacy.in_reply_to_screen_name ?? "",
			user_id: legacy.in_reply_to_user_id_str ?? "",
		};
	}

	const quotedRaw = result.quoted_status_result?.result;
	const quotedId = legacy.quoted_status_id_str ?? unwrap(quotedRaw)?.legacy?.id_str;
	if (quotedId) {
		tweet.quoted_id = quotedId;
		const permalink = legacy.quoted_status_permalink?.expanded;
		if (permalink) tweet.quoted_url = permalink;
		if (quotedRaw) ingestTweet(acc, quotedRaw, { skipRetweets: false });
	}

	bakeCard(acc, result, urls);

	acc.tweets.set(id, tweet);
	return id;
}

export function ingestPage(acc, raw) {
	let ownerNew = 0;
	for (const r of timelineResults(raw)) {
		const before = acc.tweets.size;
		const id = ingestTweet(acc, r);
		if (id && acc.tweets.size > before) {
			const t = acc.tweets.get(id);
			if (t.user_id === acc.ownerId) ownerNew++;
		}
	}
	return ownerNew;
}

export function mapProfile(acc, user) {
	const avatarRemote = fullPfp(user.profile_picture?.url ?? "");
	let avatarPath = "";
	if (avatarRemote) {
		avatarPath = `${acc.folder}/pfps/${user.id}.jpg`;
		if (!acc.media.has(avatarPath))
			acc.media.set(avatarPath, { remote: avatarRemote, headers: MEDIA_REFERER });
	}
	let bannerPath = "";
	if (user.banner) {
		bannerPath = `${acc.folder}/pfps/${user.id}-banner.jpg`;
		if (!acc.media.has(bannerPath))
			acc.media.set(bannerPath, { remote: user.banner, headers: MEDIA_REFERER });
	}
	const urlEntity = user.misc?.entities?.url?.urls?.[0];
	return {
		folder: acc.folder,
		id: user.id,
		name: user.name ?? user.username ?? "",
		handle: user.username ?? "",
		avatar: avatarPath,
		banner: bannerPath,
		verified: !!(user.verification?.verified || user.verification?.premium_verified),
		bio: user.description ?? "",
		location: plainLocation(user.location),
		url: user.url ?? urlEntity?.url ?? "",
		url_expanded: urlEntity?.expanded_url ?? "",
		created_at: user.created_at ?? "",
		following: user.stats?.following ?? 0,
		followers: user.stats?.followers?.count ?? 0,
		posts: user.stats?.posts ?? 0,
	};
}
