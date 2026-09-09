export const MOBILE_MEDIA_QUERY = "(max-width: 900px)";

export function shouldSubmitOnEnter(options: { key: string; shiftKey: boolean; isComposing: boolean; mobile: boolean }): boolean {
  return options.key === "Enter" && !options.shiftKey && !options.isComposing && !options.mobile;
}
