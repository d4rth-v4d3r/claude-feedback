import * as vscode from "vscode";
import type { AppState, ReviewComment, ReviewMessage } from "./types";

const WORKSPACE_STATE_KEY = "codeReviewSidebarState";
const GLOBAL_STATE_KEY = "codeReviewSidebarState.global";

export type StoreListener = () => void;

/**
 * Single source of truth for review state. Wraps `globalState` so the
 * tree view, comments controller, editor hints, and send pipeline all
 * read/write through one object and observe the same change events.
 */
export class ReviewStore {
  private state: AppState;
  private readonly listeners = new Set<StoreListener>();

  constructor(private readonly context: vscode.ExtensionContext) {
    const globalState = context.globalState.get<AppState>(GLOBAL_STATE_KEY);
    const workspaceState = context.workspaceState.get<AppState>(WORKSPACE_STATE_KEY);
    const raw = globalState ?? workspaceState ?? { pending: [], reviews: [] };
    this.state = migrateState(raw);

    if (!globalState) {
      void context.globalState.update(GLOBAL_STATE_KEY, this.state);
    }
  }

  getState(): AppState {
    return this.state;
  }

  getPending(): ReviewComment[] {
    return this.state.pending;
  }

  /** Active (status === "pending") only. Used by the tree view and the send pipeline. */
  getActivePending(): ReviewComment[] {
    return this.state.pending.filter((c) => c.status === "pending");
  }

  findById(id: string): ReviewComment | undefined {
    return (
      this.state.pending.find((c) => c.id === id) ??
      this.state.reviews.flatMap((b) => b.comments).find((c) => c.id === id)
    );
  }

  onDidChange(listener: StoreListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  async update(mutator: (state: AppState) => void): Promise<void> {
    mutator(this.state);
    await this.context.globalState.update(GLOBAL_STATE_KEY, this.state);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listeners must never throw; swallow to keep state consistent.
      }
    }
  }
}

function migrateState(raw: AppState): AppState {
  return {
    pending: (raw.pending ?? []).map(migrateComment),
    reviews: (raw.reviews ?? []).map((batch) => ({
      ...batch,
      comments: (batch.comments ?? []).map(migrateComment),
    })),
  };
}

/**
 * Promote legacy `{ comment: string }` shape to `{ messages: [...] }` and
 * default `status` to "pending". The legacy field is preserved so older
 * extension versions installed alongside this one keep working.
 */
function migrateComment(c: ReviewComment): ReviewComment {
  if (c.messages && c.messages.length > 0) {
    return { ...c, status: c.status ?? "pending" };
  }
  const seedBody = (c.comment ?? "").trim();
  const messages: ReviewMessage[] = seedBody
    ? [
        {
          id: `${c.id}-m0`,
          author: "You",
          body: seedBody,
          createdAt: c.createdAt,
        },
      ]
    : [];
  return { ...c, messages, status: c.status ?? "pending" };
}

/** Concatenates messages into the format the send pipeline appends per comment. */
export function commentBodyForSend(comment: ReviewComment): string {
  if (!comment.messages.length) {
    return (comment.comment ?? "").trim();
  }
  if (comment.messages.length === 1) {
    return comment.messages[0].body.trim();
  }
  return comment.messages
    .map((m, idx) => (idx === 0 ? m.body.trim() : `↳ ${m.author}: ${m.body.trim()}`))
    .join("\n");
}
