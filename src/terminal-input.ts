export class TerminalInputQueue {
  private pending = "";
  private sending = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly send: (data: string) => Promise<unknown>, private readonly onError: (reason: unknown) => void) {}
  write(data: string): boolean {
    if (this.stopped || data.length + this.pending.length > 32768) return false;
    this.pending += data;
    if (!this.sending && !this.timer) this.timer = setTimeout(() => void this.flush(), 4);
    return true;
  }
  dispose(): void { this.stopped = true; this.pending = ""; clearTimeout(this.timer); }
  private async flush(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.sending) return;
    this.sending = true;
    try {
      while (this.pending && !this.stopped) {
        let size = Math.min(4096, this.pending.length);
        const last = this.pending.charCodeAt(size - 1);
        if (size < this.pending.length && last >= 0xd800 && last <= 0xdbff) size--;
        const data = this.pending.slice(0, size);
        this.pending = this.pending.slice(size);
        await this.send(data);
      }
    } catch (reason) { if (!this.stopped) { this.dispose(); this.onError(reason); } }
    finally { this.sending = false; }
  }
}
