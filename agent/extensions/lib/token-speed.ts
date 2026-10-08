/**
 * Standard LLM speed pair: time to first token (prompt processing + queueing)
 * and generation speed (output tokens over first-token-to-last-token time).
 */
export class TokenSpeed {
	private startedAt: number | undefined;
	private firstAt: number | undefined;
	ttft: number | undefined;
	rate: number | undefined;
	start(now = performance.now()) {
		this.startedAt = now;
		this.firstAt = undefined;
		this.ttft = undefined;
		this.rate = undefined;
	}
	firstToken(now = performance.now()) {
		if (this.startedAt === undefined || this.firstAt !== undefined) return;
		this.firstAt = now;
		this.ttft = (now - this.startedAt) / 1000;
	}
	update(outputTokens: number | undefined, now = performance.now()) {
		if (this.firstAt === undefined || !Number.isFinite(outputTokens) || !outputTokens || outputTokens < 2) return this.rate;
		const seconds = (now - this.firstAt) / 1000;
		// The first token is emitted at firstAt; the rest are generated over `seconds`.
		if (seconds > 0) this.rate = (outputTokens - 1) / seconds;
		return this.rate;
	}
	reset() { this.startedAt = undefined; this.firstAt = undefined; this.ttft = undefined; this.rate = undefined; }
}
