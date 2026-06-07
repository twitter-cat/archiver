import chalk from "chalk";

const BLUE = "#1d9bf0";
const SKY = "#7cc4f5";
const SLATE = "#3a4a5a";

export const c = {
  brand: chalk.hex(BLUE),
  brandBold: chalk.hex(BLUE).bold,
  sky: chalk.hex(SKY),
  title: chalk.bold.whiteBright,
  dim: chalk.dim,
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  bar: chalk.hex(BLUE),
  barDim: chalk.hex(SLATE),
};

export const sym = {
  ok: c.ok("✓"),
  err: c.err("✗"),
  warn: c.warn("▲"),
  info: c.brand("›"),
  dot: c.dim("·"),
  arrow: c.dim("→"),
};
