/**
 * dsh-balance-peek — Browser half.
 *
 * Hand-written as a `window.__ModuleLoader__` registration row: the only entry
 * point `@deepseek-ai/dsh-client-modules` serves from /plugins, and the shape
 * the shell materializes lazily. `require` inside the factory resolves against
 * the shell's platform module table, so React comes from the page itself and
 * this plugin ships no runtime of its own.
 *
 * Seating: one entry in `sidebar.footer.action`, the list slot beside Settings
 * at the sidebar foot. The entry is pure text — two short lines when the column
 * is wide, a two-cell readout in the 56px rail.
 *
 * The peak/off-peak state is computed locally from the browser clock with the
 * same rules the Host uses, so the countdown ticks every second without any
 * request. The Host is polled once a minute for the wallet.
 */
window.__ModuleLoader__.load({
	id: "dsh-balance-peek",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;
		const { useEffect, useRef, useState } = React;

		/** Matches the Host's own cache TTL; the Host is the source of truth. */
		const POLL_MS = 60_000;

		const PEAK_HOURS = [
			[9, 12],
			[14, 18],
		];

		/** Keep in sync with lib/index.js (State Council arrangement, published yearly). */
		const HOLIDAY_VALLEY = new Set([
			"2026-01-01", "2026-01-02", "2026-01-03",
			"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
			"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
			"2026-04-04", "2026-04-05", "2026-04-06",
			"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
			"2026-06-19", "2026-06-20", "2026-06-21",
			"2026-09-25", "2026-09-26", "2026-09-27",
			"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
			"2026-10-06", "2026-10-07",
		]);

		const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

		function beijingParts(ms) {
			const d = new Date(ms + BEIJING_OFFSET_MS);
			return {
				day: d.toISOString().slice(0, 10),
				hour: d.getUTCHours(),
				weekday: d.getUTCDay(),
			};
		}

		function isPeak(ms) {
			const parts = beijingParts(ms);
			if (parts.weekday === 0 || parts.weekday === 6) return false;
			if (HOLIDAY_VALLEY.has(parts.day)) return false;
			return PEAK_HOURS.some(([start, end]) => parts.hour >= start && parts.hour < end);
		}

		/** Seconds until the next peak/off-peak flip, or null beyond 8 days. */
		function secondsToSwitch(ms) {
			const current = isPeak(ms);
			const start = Math.floor(ms / 1000);
			for (let t = start + 1; t <= start + 8 * 24 * 3600; t += 60) {
				if (isPeak(t * 1000) !== current) return t - start;
			}
			return null;
		}

		/** `1h06m`, `3d4h`, `12m`. */
		function humanDuration(seconds) {
			if (seconds === null || seconds === undefined) return "—";
			const total = Math.max(0, Math.round(seconds));
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			if (days > 0) return days + "d" + hours + "h";
			if (hours > 0) return hours + "h" + String(minutes).padStart(2, "0") + "m";
			return Math.max(1, minutes) + "m";
		}

		function money(amount, currency) {
			if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
			return (currency === "USD" ? "$" : "¥") + amount.toFixed(2);
		}

		function clockOf(ms) {
			return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
		}

		/** Where the number came from, in words. */
		function sourceLabel(source) {
			if (source === "apikey") return "API Key";
			if (source === "account") return "登录账号";
			return "—";
		}

		/** Visual tokens. Every color comes from the live theme. */
		const CSS = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				width: "100%",
				minWidth: 0,
				margin: 0,
				padding: "4px 8px 6px",
				boxSizing: "border-box",
				background: "none",
				border: "none",
				borderRadius: "6px",
				textAlign: "left",
				font: "inherit",
				color: "inherit",
				cursor: "pointer",
			},
			line: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: "8px",
				minWidth: 0,
				lineHeight: "1.45",
				whiteSpace: "nowrap",
				overflow: "hidden",
			},
			key: {
				flex: "0 0 auto",
				fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
			},
			value: {
				fontSize: "12px",
				fontVariantNumeric: "tabular-nums",
				color: "var(--dsw-alias-label-primary)",
				overflow: "hidden",
				textOverflow: "ellipsis",
			},
			periodValley: {
				fontSize: "11px",
				fontVariantNumeric: "tabular-nums",
				color: "var(--dsw-alias-state-success-primary)",
			},
			periodPeak: {
				fontSize: "11px",
				fontVariantNumeric: "tabular-nums",
				color: "var(--dsw-alias-state-warn-primary)",
			},
			rail: {
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: "3px",
				margin: 0,
				padding: "6px 0",
				background: "none",
				border: "none",
				font: "inherit",
				color: "inherit",
				cursor: "pointer",
			},
			railTop: {
				fontSize: "11px",
				fontVariantNumeric: "tabular-nums",
				color: "var(--dsw-alias-label-primary)",
			},
			railValley: {
				fontSize: "10px",
				fontVariantNumeric: "tabular-nums",
				color: "var(--dsw-alias-state-success-primary)",
			},
			railPeak: {
				fontSize: "10px",
				fontVariantNumeric: "tabular-nums",
				color: "var(--dsw-alias-state-warn-primary)",
			},
			detail: {
				display: "flex",
				flexDirection: "column",
				gap: "3px",
				marginTop: "4px",
				paddingTop: "4px",
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
			},
			detailRow: {
				display: "flex",
				justifyContent: "space-between",
				gap: "8px",
				whiteSpace: "nowrap",
			},
			error: {
				fontSize: "11px",
				lineHeight: "1.35",
				whiteSpace: "normal",
				color: "var(--dsw-alias-state-error-primary)",
			},
		};

		/** Last manual refresh trigger, published for the click handler. */
		let refreshNow = null;

		/**
		 * The sidebar-foot readout: the wallet balance, plus which price window
		 * the clock is currently in.
		 *
		 * @param props.wide - false while the sidebar is the 56px rail.
		 */
		function BalanceReadout(props) {
			const wide = props.wide !== false;
			const [snapshot, setSnapshot] = useState(null);
			const [error, setError] = useState(null);
			const [open, setOpen] = useState(false);
			const [now, setNow] = useState(() => Date.now());
			const inFlight = useRef(false);

			useEffect(() => {
				let alive = true;
				const load = async (force) => {
					if (inFlight.current) return;
					inFlight.current = true;
					try {
						const res = await fetch("/dsh-balance/state.json" + (force ? "?refresh=1" : ""), {
							headers: { accept: "application/json" },
						});
						const body = await res.json();
						if (!alive) return;
						if (body && body.ok) {
							setSnapshot(body);
							setError(body.balanceError || null);
						} else {
							setError((body && body.error) || "读取失败");
						}
					} catch (err) {
						if (alive) setError(String((err && err.message) || err));
					} finally {
						inFlight.current = false;
					}
				};
				void load(false);
				const timer = setInterval(() => void load(false), POLL_MS);
				refreshNow = () => void load(true);
				return () => {
					alive = false;
					clearInterval(timer);
					refreshNow = null;
				};
			}, []);

			// The period marker ticks locally, so the countdown moves even while
			// the wallet poll is idle.
			useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, []);

			const peak = isPeak(now);
			const remaining = humanDuration(secondsToSwitch(now));
			const currency = (snapshot && snapshot.currency) || "CNY";
			const balance = money(snapshot ? snapshot.balance : null, currency);
			const countdown = remaining + (peak ? " 后转谷" : " 后转峰");

			const onActivate = () => {
				if (!open && refreshNow) refreshNow();
				setOpen(!open);
			};

			const title = balance + " · " + (peak ? "峰价" : "谷价") + " · " + countdown + (error ? " · " + error : "");
			const aria = "DeepSeek 余额 " + balance + "，当前" + (peak ? "高峰时段" : "空闲时段") + "，" + countdown;

			if (!wide) {
				return h(
					"button",
					{ type: "button", style: CSS.rail, title: title, "aria-label": aria, onClick: onActivate },
					h("span", { style: CSS.railTop }, balance),
					h("span", { style: peak ? CSS.railPeak : CSS.railValley }, peak ? "峰" : "谷"),
				);
			}

			const rows = [
				h(
					"span",
					{ key: "period", style: CSS.detailRow },
					h("span", null, peak ? "高峰时段" : "空闲时段"),
					h("span", null, countdown),
				),
			];
			if (snapshot && snapshot.balanceAt) {
				rows.push(
					h(
						"span",
						{ key: "at", style: CSS.detailRow },
						h("span", null, "余额更新"),
						h("span", null, clockOf(snapshot.balanceAt)),
					),
				);
			}
			if (snapshot) {
				rows.push(
					h(
						"span",
						{ key: "source", style: CSS.detailRow },
						h("span", null, "来源"),
						h("span", null, sourceLabel(snapshot.balanceSource)),
					),
				);
			}
			if (error) rows.push(h("span", { key: "error", style: CSS.error }, error));

			return h(
				"button",
				{ type: "button", style: CSS.root, title: "点击刷新并展开明细", "aria-label": aria, onClick: onActivate },
				h("span", { style: CSS.line }, h("span", { style: CSS.key }, "余额"), h("span", { style: CSS.value }, balance)),
				h(
					"span",
					{ style: CSS.line },
					h("span", { style: CSS.key }, peak ? "高峰" : "空闲"),
					h("span", { style: peak ? CSS.periodPeak : CSS.periodValley }, countdown),
				),
				open ? h("span", { style: CSS.detail }, rows) : null,
			);
		}

		exports.inject = ["slots"];
		exports.apply = function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "dsh-balance-peek",
						order: 30,
						label: () => "DeepSeek 余额",
					},
					BalanceReadout,
				),
			);
		};

		return module.exports;
	},
});
