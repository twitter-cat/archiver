import { c, sym } from "./ui.js";

const isTTY = process.stdout.isTTY;

function fmtDuration(secs) {
	if (!Number.isFinite(secs) || secs < 0) return "--:--";
	const s = Math.round(secs);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function write(line) {
	if (isTTY) process.stdout.write(`\r\x1b[2K${line}`);
}

export class ProgressBar {
	constructor(total, { label = "", width = 24 } = {}) {
		this.total = total;
		this.label = label;
		this.width = width;
		this.done = 0;
		this.start = performance.now();
		this.lastDraw = 0;
	}

	tick(n = 1) {
		this.done += n;
		this.render();
	}

	setDone(done, note = "") {
		this.done = done;
		this.note = note;
		this.render();
	}

	render(force = false) {
		const now = performance.now();
		if (!force && now - this.lastDraw < 80 && this.done < this.total) return;
		this.lastDraw = now;
		const frac = this.total ? Math.min(1, this.done / this.total) : 0;
		const filled = Math.round(frac * this.width);
		const bar = c.bar("█".repeat(filled)) + c.barDim("░".repeat(this.width - filled));
		const elapsed = (now - this.start) / 1000;
		const rate = elapsed > 0 ? this.done / elapsed : 0;
		const remaining =
			rate > 0 ? Math.max(0, this.total - this.done) / rate : Number.POSITIVE_INFINITY;
		const pct = String(Math.floor(frac * 100)).padStart(3, " ");
		const parts = [
			this.label ? c.brand(this.label) : "",
			`${c.dim("[")}${bar}${c.dim("]")} ${c.title(`${pct}%`)}`,
			c.dim(`${this.done}/${this.total}`),
			c.dim(`${rate >= 1 ? rate.toFixed(0) : rate.toFixed(1)}/s`),
			c.dim(`ETA ${fmtDuration(remaining)}`),
		];
		if (this.note) parts.push(c.dim(this.note));
		write(parts.filter(Boolean).join(` ${sym.dot} `));
	}

	finish(msg) {
		this.render(true);
		if (isTTY) process.stdout.write(`  ${sym.ok}\n`);
		if (msg) console.log(msg);
	}
}

export class Spinner {
	constructor(label) {
		this.label = label;
		this.count = 0;
		this.extra = "";
		this.start = performance.now();
		this.frame = 0;
		this.frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		this.timer = null;
		if (isTTY) this.timer = setInterval(() => this.render(), 120);
	}

	set(count, extra = "") {
		this.count = count;
		this.extra = extra;
		this.render();
	}

	render() {
		const f = this.frames[(this.frame = (this.frame + 1) % this.frames.length)];
		const elapsed = (performance.now() - this.start) / 1000;
		const rate = elapsed > 0 ? this.count / elapsed : 0;
		const bits = [
			`${c.brand(f)} ${c.brand(this.label)}`,
			c.dim(`${this.count} found`),
			c.dim(`${rate >= 1 ? rate.toFixed(0) : rate.toFixed(1)}/s`),
			c.dim(fmtDuration(elapsed)),
		];
		if (this.extra) bits.push(c.dim(this.extra));
		write(bits.join(` ${sym.dot} `));
	}

	stop(msg) {
		if (this.timer) clearInterval(this.timer);
		if (isTTY) process.stdout.write("\r\x1b[2K");
		if (msg) console.log(msg);
	}
}

export { fmtDuration };
