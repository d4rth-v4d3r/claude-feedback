export type ReviewMessage = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** ISO timestamp of last edit, if any. */
  editedAt?: string;
};

export type ReviewCommentStatus = "pending" | "resolved";

export type ReviewComment = {
  id: string;
  filePath: string;
  relativePath: string;
  line: number;
  /** Snapshot of ±2 lines around the anchor at creation time, used to re-anchor on save. */
  context: string[];
  /** Thread of messages — the first one is the original review comment. */
  messages: ReviewMessage[];
  status: ReviewCommentStatus;
  repoName: string;
  repoPath: string;
  worktreeName: string;
  workspaceFolderPath: string;
  branchName: string;
  createdAt: string;
  /**
   * Legacy single-string comment field. Kept optional for read compatibility with state
   * persisted by older versions; new comments always populate `messages` instead.
   */
  comment?: string;
};

export type ReviewBatch = {
  id: string;
  createdAt: string;
  comments: ReviewComment[];
  copiedText: string;
};

export type AppState = {
  pending: ReviewComment[];
  reviews: ReviewBatch[];
};
