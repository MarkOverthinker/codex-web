export type BillingRange = number | { from: string; to: string };

export function billingQuery(range: BillingRange): string {
  return new URLSearchParams(typeof range === "number" ? { days: String(range) } : range).toString();
}

export function localBillingRange(startDate: string, endDate: string, startTime = "00:00", endTime = "23:59"): Exclude<BillingRange, number> {
  if (![startDate, endDate].every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    || ![startTime, endTime].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new Error("请选择有效的起止日期和时间。");
  }
  const start = new Date(`${startDate}T${startTime}:00`);
  const end = new Date(`${endDate}T${endTime}:00`);
  for (const date of [startDate, endDate]) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("请选择有效的日期。");
  }
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error("结束日期和时间不能早于开始日期和时间。");
  }
  return { from: start.toISOString(), to: new Date(end.getTime() + 60_000).toISOString() };
}
