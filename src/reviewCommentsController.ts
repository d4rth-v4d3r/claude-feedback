import * as vscode from "vscode";
import type { ReviewComment, ReviewMessage } from "./types";
import type { ReviewStore } from "./store";

const CONTROLLER_ID = "codeReview.comments";
const CONTROLLER_LABEL = "Code Review";

const CTX_VALUE_PENDING = "codeReview.pending";

/**
 * Wraps a `vscode.CommentController` to project our `ReviewComment[]` model
 * onto the native PR-style comments UI:
 *   - One `CommentThread` per `ReviewComment`
 *   - One `Comment` per `ReviewMessage`
 *   - Resolved threads are collapsed via `CommentThreadState.Resolved`
 *
 * Threads are rebuilt from the store on every change and re-anchored on
 * save by fuzzy-matching `comment.context[]` against the new file content.
 */
export class ReviewCommentsController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ReviewStore,
    private readonly addCommentForUri: (uri: vscode.Uri, line: number, body: string) => Promise<void>
  ) {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (document.uri.scheme !== "file" && document.uri.scheme !== "git") {
          return [];
        }
        const last = Math.max(0, document.lineCount - 1);
        return [new vscode.Range(0, 0, last, 0)];
      },
    };
    this.disposables.push(this.controller);

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.reanchorOnSave(doc))
    );

    this.disposables.push(this.store.onDidChange(() => this.refresh()));

    this.refresh();
  }

  dispose(): void {
    for (const t of this.threads.values()) {
      t.dispose();
    }
    this.threads.clear();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /** Rebuild threads from the store. Cheap because we just create/dispose VS Code objects. */
  refresh(): void {
    const desired = new Map<string, ReviewComment>();
    for (const c of this.store.getPending()) {
      desired.set(c.id, c);
    }

    for (const [id, thread] of this.threads) {
      if (!desired.has(id)) {
        thread.dispose();
        this.threads.delete(id);
      }
    }

    for (const [id, comment] of desired) {
      const existing = this.threads.get(id);
      if (existing) {
        this.applyToThread(existing, comment);
        continue;
      }
      const thread = this.createThread(comment);
      if (thread) {
        this.threads.set(id, thread);
      }
    }
  }

  // --- Reply / edit / delete / resolve, all called by extension command bindings ---

  /** Adds a message to an existing thread, OR creates a new comment if the thread is fresh. */
  async handleReply(reply: vscode.CommentReply): Promise<void> {
    const text = (reply.text ?? "").trim();
    if (!text) {
      return;
    }
    const commentId = this.findCommentIdForThread(reply.thread);
    if (commentId) {
      await this.appendMessage(commentId, text);
      return;
    }

    // Empty placeholder thread created by VS Code when the user clicked the
    // gutter `+`. We don't own it (it's not in `this.threads`), so capture its
    // anchor, dispose it, and create our own ReviewComment — `refresh()` will
    // mount a managed thread on the same line. Without the dispose, the
    // placeholder lingers as a "Start discussion" ghost row.
    const uri = reply.thread.uri;
    const line = (reply.thread.range?.start.line ?? 0) + 1;
    reply.thread.dispose();
    await this.addCommentForUri(uri, line, text);
  }

  async appendMessage(commentId: string, body: string): Promise<void> {
    const text = body.trim();
    if (!text) {
      return;
    }
    await this.store.update((state) => {
      const c = state.pending.find((p) => p.id === commentId);
      if (!c) {
        return;
      }
      c.messages = [
        ...(c.messages ?? []),
        { id: `${commentId}-m${c.messages?.length ?? 0}`, author: "You", body: text, createdAt: new Date().toISOString() },
      ];
      c.status = "pending";
    });
  }

  async editMessage(commentId: string, messageId: string, nextBody: string): Promise<void> {
    const text = nextBody.trim();
    if (!text) {
      return;
    }
    await this.store.update((state) => {
      const c = state.pending.find((p) => p.id === commentId);
      if (!c) {
        return;
      }
      const m = c.messages.find((mm) => mm.id === messageId);
      if (m) {
        m.body = text;
        m.editedAt = new Date().toISOString();
      }
    });
  }

  async deleteMessage(commentId: string, messageId: string): Promise<void> {
    await this.store.update((state) => {
      const c = state.pending.find((p) => p.id === commentId);
      if (!c) {
        return;
      }
      c.messages = c.messages.filter((m) => m.id !== messageId);
      if (c.messages.length === 0) {
        state.pending = state.pending.filter((p) => p.id !== commentId);
      }
    });
  }

  async deleteThread(commentId: string): Promise<void> {
    await this.store.update((state) => {
      state.pending = state.pending.filter((p) => p.id !== commentId);
    });
  }

  async toggleResolved(commentId: string): Promise<void> {
    await this.store.update((state) => {
      const c = state.pending.find((p) => p.id === commentId);
      if (c) {
        c.status = c.status === "resolved" ? "pending" : "resolved";
      }
    });
  }

  /**
   * Reveals the thread for a comment in its file editor (used when the tree
   * view's diff opener also wants to focus on a specific thread).
   */
  async reveal(commentId: string): Promise<void> {
    const comment = this.store.findById(commentId);
    if (!comment) {
      return;
    }
    const uri = vscode.Uri.file(comment.filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const lineIdx = Math.max(0, Math.min(comment.line - 1, doc.lineCount - 1));
    editor.selection = new vscode.Selection(lineIdx, 0, lineIdx, 0);
    editor.revealRange(new vscode.Range(lineIdx, 0, lineIdx, 0), vscode.TextEditorRevealType.InCenter);
    const thread = this.threads.get(commentId);
    if (thread) {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  // --- Internal helpers ---

  private createThread(comment: ReviewComment): vscode.CommentThread | undefined {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.file(comment.filePath);
    } catch {
      return undefined;
    }
    const range = new vscode.Range(
      Math.max(0, comment.line - 1),
      0,
      Math.max(0, comment.line - 1),
      0
    );
    const thread = this.controller.createCommentThread(
      uri,
      range,
      this.toVscodeComments(comment)
    );
    this.applyToThread(thread, comment);
    return thread;
  }

  private applyToThread(thread: vscode.CommentThread, comment: ReviewComment): void {
    thread.label = `Pending review · L${comment.line}`;
    thread.canReply = true;
    thread.contextValue = CTX_VALUE_PENDING;
    thread.state =
      comment.status === "resolved"
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    thread.collapsibleState =
      comment.status === "resolved"
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
    thread.comments = this.toVscodeComments(comment);

    const desiredLine = Math.max(0, comment.line - 1);
    if (thread.range?.start.line !== desiredLine) {
      thread.range = new vscode.Range(desiredLine, 0, desiredLine, 0);
    }
  }

  private toVscodeComments(comment: ReviewComment): vscode.Comment[] {
    return comment.messages.map((m) => this.toVscodeComment(comment, m));
  }

  private toVscodeComment(comment: ReviewComment, message: ReviewMessage): VscodeComment {
    return {
      author: { name: message.author },
      body: new vscode.MarkdownString(message.body),
      mode: vscode.CommentMode.Preview,
      contextValue: CTX_VALUE_PENDING,
      timestamp: new Date(message.createdAt),
      label: message.editedAt ? "edited" : undefined,
      // Custom backref so command handlers can locate the model from the Comment instance.
      reviewCommentId: comment.id,
      reviewMessageId: message.id,
    };
  }

  private findCommentIdForThread(thread: vscode.CommentThread): string | undefined {
    for (const [id, t] of this.threads) {
      if (t === thread) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Walk pending comments anchored to `doc` and update each `comment.line`
   * based on a fuzzy match of `comment.context[]` against the new content.
   * The update goes through the store, which triggers a refresh that moves
   * the threads to their new line.
   */
  private async reanchorOnSave(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme !== "file") {
      return;
    }
    const fsPath = doc.uri.fsPath;
    const documentLines = doc.getText().split(/\r?\n/);

    let changed = false;
    const updates: { id: string; nextLine: number }[] = [];

    for (const comment of this.store.getPending()) {
      if (comment.filePath !== fsPath) {
        continue;
      }
      const nextLine = locateAnchorLine(documentLines, comment);
      if (nextLine !== undefined && nextLine !== comment.line) {
        updates.push({ id: comment.id, nextLine });
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    await this.store.update((state) => {
      for (const u of updates) {
        const c = state.pending.find((p) => p.id === u.id);
        if (c) {
          c.line = u.nextLine;
        }
      }
    });
  }
}

/**
 * `vscode.Comment` is structural. We attach `reviewCommentId` / `reviewMessageId`
 * so command handlers (which receive a `Comment`) can identify the model row.
 */
type VscodeComment = vscode.Comment & {
  reviewCommentId: string;
  reviewMessageId: string;
};

export function isReviewComment(c: vscode.Comment): c is VscodeComment {
  return typeof (c as VscodeComment).reviewCommentId === "string";
}

/**
 * Picks the line in `documentLines` whose surrounding window best matches
 * `comment.context[]`. Returns `undefined` if every candidate scores zero
 * (in which case we keep the old line — the user can manually fix it).
 *
 * Strategy: compare each candidate window of 5 lines (matching the ±2
 * snapshot we stored at creation) and score by trimmed-line equality. The
 * best score wins; ties prefer the candidate closest to the original line.
 */
function locateAnchorLine(documentLines: string[], comment: ReviewComment): number | undefined {
  const expected = (comment.context ?? []).map(stripContextMarker);
  if (expected.length === 0) {
    return undefined;
  }
  const anchorOffset = expected.findIndex((l) => l.startsWith(">"));
  const cleanedExpected = expected.map((l) => stripLeadingMarker(l));
  if (cleanedExpected.every((l) => l.length === 0)) {
    return undefined;
  }

  let bestLine: number | undefined;
  let bestScore = 0;

  const windowSize = cleanedExpected.length;
  const totalLines = documentLines.length;
  for (let start = 0; start <= Math.max(0, totalLines - windowSize); start += 1) {
    let score = 0;
    for (let i = 0; i < windowSize; i += 1) {
      const got = (documentLines[start + i] ?? "").trim();
      const want = cleanedExpected[i].trim();
      if (got && got === want) {
        score += i === anchorOffset ? 2 : 1;
      }
    }
    if (
      score > bestScore ||
      (score === bestScore && bestLine !== undefined && Math.abs(start - (comment.line - 1)) < Math.abs(bestLine - (comment.line - 1)))
    ) {
      bestScore = score;
      bestLine = start;
    }
  }

  if (bestLine === undefined || bestScore === 0) {
    return undefined;
  }
  const anchorLine = bestLine + (anchorOffset >= 0 ? anchorOffset : 0) + 1;
  return Math.max(1, Math.min(totalLines, anchorLine));
}

function stripContextMarker(line: string): string {
  return line.replace(/^[> ]\s*L\d+:\s?/, (m) => (m.startsWith(">") ? ">" : ""));
}

function stripLeadingMarker(line: string): string {
  return line.startsWith(">") ? line.slice(1).trim() : line.trim();
}
