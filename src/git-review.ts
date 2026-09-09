export type ReviewScope = "working" | "staged" | "branch";
export type ReviewFile = { path: string; status: string; additions: number | null; deletions: number | null };
export type GitReview = {
  root: string;
  branch: string;
  bases: string[];
  base: string | null;
  comparison: string;
  files: ReviewFile[];
  patch?: string;
  truncated?: boolean;
};
export type GitReviewRequest = { workingDir: string; restrictRoot: boolean; scope: ReviewScope; base?: string; file?: string };
