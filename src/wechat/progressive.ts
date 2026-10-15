export type SendFn = (text: string) => Promise<unknown>;

/**
 * Turns streamed assistant text deltas into a small number of sent messages.
 * WeChat has no message editing, so we send in chunks of at least `limit`
 * characters rather than per-token (which would spam the chat).
 */
export class ProgressiveSender {
  private pending = "";
  private sentAny = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly send: SendFn,
    private readonly limit: number,
  ) {}

  /** Feed a streamed text delta; flushes a chunk once the buffer fills. */
  push(delta: string): void {
    if (!delta) return;
    this.pending += delta;
    while (this.pending.length >= this.limit) {
      const chunk = this.pending.slice(0, this.limit).trim();
      this.pending = this.pending.slice(this.limit);
      if (chunk) this.dispatch(chunk);
    }
  }

  private dispatch(text: string): void {
    this.sentAny = true;
    this.chain = this.chain.then(() => this.send(text)).catch(() => undefined);
  }

  /**
   * Discard text buffered so far from an abandoned model attempt (e.g. before a
   * fallback retry), so its stale tail is not prepended to the new reply.
   * Already-sent chunks cannot be unsent; `sentAny` is kept so `finish` will not
   * resend the whole fallback on top of them.
   */
  reset(): void {
    this.pending = "";
  }

  /**
   * Flush remaining streamed text. When nothing was streamed (e.g. a
   * non-streaming model), send `fallbackReply` so the reply is never lost.
   */
  async finish(fallbackReply = ""): Promise<void> {
    const leftover = this.pending.trim();
    this.pending = "";
    if (leftover) this.dispatch(leftover);
    await this.chain;
    if (!this.sentAny && fallbackReply.trim()) {
      this.sentAny = true;
      await this.send(fallbackReply.trim());
    }
  }

  /** Whether any text has been streamed (sent or pending). */
  get streamed(): boolean {
    return this.sentAny || this.pending.length > 0;
  }
}
