import { readFile } from "node:fs/promises";
import Emusks from "emusks";

const RATE_LIMIT = /rate limit|over capacity|code 88|too many requests|429/i;
const AUTH_FATAL =
	/could not authenticate|temporarily locked|suspended|bad guest token|denied by access control|not authorized/i;

function classify(err) {
	const msg = String(err?.message || err || "");
	if (RATE_LIMIT.test(msg)) return "ratelimit";
	if (AUTH_FATAL.test(msg)) return "fatal";
	return "other";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loadTokens({ tokens = [], tokensFile } = {}) {
	const out = [...tokens];
	if (tokensFile) {
		const text = await readFile(tokensFile, "utf8");
		out.push(...text.split(/[\s,]+/));
	}
	if (process.env.ARCHIVER_TOKENS) out.push(...process.env.ARCHIVER_TOKENS.split(/[\s,]+/));
	const seen = new Set();
	return out
		.map((t) => t.trim())
		.filter((t) => t && !t.startsWith("#") && !seen.has(t) && seen.add(t));
}

export class AccountPool {
	constructor({ client, endpoint, baseCooldown = 30_000, maxCooldown = 15 * 60_000 } = {}) {
		this.slots = [];
		this.clientOpt = client;
		this.endpoint = endpoint;
		this.baseCooldown = baseCooldown;
		this.maxCooldown = maxCooldown;
	}

	get healthy() {
		return this.slots.filter((s) => !s.dead).length;
	}

	async login(tokens, { onStatus } = {}) {
		let i = 0;
		for (const token of tokens) {
			i++;
			const client = new Emusks();
			try {
				const loginArg = { auth_token: token };
				if (this.clientOpt) loginArg.client = this.clientOpt;
				if (this.endpoint) loginArg.endpoint = this.endpoint;
				await client.login(loginArg);
				let username = `account ${i}`;
				try {
					const me = await client.account.viewer();
					if (me?.username) username = `@${me.username}`;
				} catch {}
				this.slots.push({
					client,
					username,
					busy: false,
					dead: false,
					cooldownUntil: 0,
					strikes: 0,
				});
				onStatus?.(`logged in ${username} (${this.slots.length}/${tokens.length})`);
			} catch (err) {
				onStatus?.(`token ${i} failed to log in: ${err.message}`);
			}
		}
		if (!this.slots.length) throw new Error("no usable accounts — every token failed to log in");
		return this.slots.length;
	}

	#available() {
		const now = Date.now();
		return this.slots.find((s) => !s.dead && !s.busy && s.cooldownUntil <= now);
	}

	#nextWake() {
		const now = Date.now();
		const live = this.slots.filter((s) => !s.dead);
		if (!live.length) return null;
		const cooling = live.filter((s) => s.cooldownUntil > now);
		if (cooling.length === live.length) {
			return Math.min(...cooling.map((s) => s.cooldownUntil)) - now;
		}
		return 0;
	}

	async run(fn, { onWait } = {}) {
		while (true) {
			const slot = this.#available();
			if (!slot) {
				const wake = this.#nextWake();
				if (wake === null)
					throw new Error("all accounts are dead (rate-limited past recovery or auth-failed)");
				if (wake > 0) {
					onWait?.(Math.ceil(wake / 1000));
					await sleep(Math.min(wake, 2000));
				} else {
					await sleep(150);
				}
				continue;
			}
			slot.busy = true;
			try {
				const res = await fn(slot.client);
				slot.busy = false;
				slot.strikes = 0;
				return res;
			} catch (err) {
				slot.busy = false;
				const kind = classify(err);
				if (kind === "fatal") {
					slot.dead = true;
					onWait?.(0, `${slot.username} retired: ${err.message}`);
					continue;
				}
				if (kind === "ratelimit") {
					const cd = Math.min(this.maxCooldown, this.baseCooldown * 2 ** slot.strikes++);
					slot.cooldownUntil = Date.now() + cd;
					onWait?.(
						Math.ceil(cd / 1000),
						`${slot.username} rate-limited, cooling ${Math.round(cd / 1000)}s`,
					);
					continue;
				}
				throw err;
			}
		}
	}
}
