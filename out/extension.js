"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const STATE_KEY = "codeReviewSidebarState";
function activate(context) {
    const provider = new CodeReviewSidebarProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("codeReviewSidebar", provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.openSidebar", async () => {
        await vscode.commands.executeCommand("workbench.view.extension.codeReviewContainer");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.addComment", async () => {
        await provider.addCommentFromActiveEditor();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.clearPending", async () => {
        await provider.clearPending();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codeReview.sendForReview", async () => {
        await provider.sendForReview();
    }));
}
class CodeReviewSidebarProvider {
    constructor(context) {
        this.context = context;
        this.state =
            this.context.workspaceState.get(STATE_KEY) ?? { pending: [], reviews: [] };
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = getWebviewHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case "ready":
                    this.postState();
                    break;
                case "openComment":
                    await this.openComment(message.commentId);
                    break;
                case "sendForReview":
                    await this.sendForReview();
                    break;
                case "clearPending":
                    await this.clearPending();
                    break;
                case "rollbackBatch":
                    await this.rollbackBatch(message.batchId);
                    break;
                case "updateComment":
                    await this.updateComment(message.commentId, message.commentText);
                    break;
            }
        });
        this.postState();
    }
    async addCommentFromActiveEditor() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Open a file in the editor before adding a review comment.");
            return;
        }
        const lineNumber = editor.selection.active.line + 1;
        const input = await vscode.window.showInputBox({
            title: "Code review comment",
            prompt: "Write feedback for this line",
            placeHolder: "Example: This logic should be extracted into a helper.",
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim().length ? null : "Comment is required."),
        });
        if (!input) {
            return;
        }
        const document = editor.document;
        const contextLines = this.readContext(document, lineNumber - 1);
        const newComment = {
            id: makeId(),
            filePath: document.uri.fsPath,
            line: lineNumber,
            comment: input.trim(),
            context: contextLines,
            createdAt: new Date().toISOString(),
        };
        this.state.pending = [newComment, ...this.state.pending];
        await this.saveState();
        this.postState();
        await vscode.commands.executeCommand("workbench.view.extension.codeReviewContainer");
        vscode.window.showInformationMessage("Review comment added to Pending.");
    }
    async clearPending() {
        if (!this.state.pending.length) {
            return;
        }
        this.state.pending = [];
        await this.saveState();
        this.postState();
    }
    async sendForReview() {
        if (!this.state.pending.length) {
            vscode.window.showWarningMessage("No pending review comments to send.");
            return;
        }
        const copiedText = buildReviewCopyText(this.state.pending);
        await vscode.env.clipboard.writeText(copiedText);
        const batch = {
            id: makeId(),
            createdAt: new Date().toISOString(),
            comments: [...this.state.pending],
            copiedText,
        };
        this.state.reviews = [batch, ...this.state.reviews];
        this.state.pending = [];
        await this.saveState();
        this.postState();
        vscode.window.showInformationMessage("Review copied and saved to Reviews.");
    }
    async rollbackBatch(batchId) {
        const index = this.state.reviews.findIndex((batch) => batch.id === batchId);
        if (index < 0) {
            return;
        }
        const [batch] = this.state.reviews.splice(index, 1);
        this.state.pending = [...batch.comments, ...this.state.pending];
        await this.saveState();
        this.postState();
    }
    async openComment(commentId) {
        const allComments = [...this.state.pending, ...this.state.reviews.flatMap((batch) => batch.comments)];
        const target = allComments.find((comment) => comment.id === commentId);
        if (!target) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(target.filePath);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const targetLine = Math.max(target.line - 1, 0);
        const range = new vscode.Range(targetLine, 0, targetLine, 0);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
    async updateComment(commentId, commentText) {
        const nextText = String(commentText ?? "").trim();
        if (!nextText.length) {
            return;
        }
        const pendingMatch = this.state.pending.find((item) => item.id === commentId);
        if (pendingMatch) {
            pendingMatch.comment = nextText;
            await this.saveState();
            this.postState();
            return;
        }
        for (const batch of this.state.reviews) {
            const match = batch.comments.find((item) => item.id === commentId);
            if (match) {
                match.comment = nextText;
                batch.copiedText = buildReviewCopyText(batch.comments);
                await this.saveState();
                this.postState();
                return;
            }
        }
    }
    readContext(document, lineIndex) {
        const start = Math.max(lineIndex - 2, 0);
        const end = Math.min(lineIndex + 2, document.lineCount - 1);
        const lines = [];
        for (let i = start; i <= end; i += 1) {
            const marker = i === lineIndex ? ">" : " ";
            const text = document.lineAt(i).text;
            lines.push(`${marker} L${i + 1}: ${text}`);
        }
        return lines;
    }
    async saveState() {
        await this.context.workspaceState.update(STATE_KEY, this.state);
    }
    postState() {
        this.view?.webview.postMessage({
            type: "state",
            state: this.state,
        });
    }
}
function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function buildReviewCopyText(comments) {
    const lines = comments.map((item) => `  - @${item.filePath} L${item.line}: ${item.comment}`);
    return [
        "Please address the following code review comments. Run `git diff` (or `git diff HEAD`) to see the full context of any changes, especially for deleted lines.",
        "",
        ...lines,
    ].join("\n");
}
function getWebviewHtml(webview) {
    const nonce = makeId().replace(/[^a-z0-9]/gi, "");
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      z-index: 10;
    }
    .tab {
      flex: 1;
      border: 0;
      background: transparent;
      color: var(--vscode-foreground);
      padding: 10px 8px;
      cursor: pointer;
      font-weight: 600;
    }
    .tab.active {
      border-bottom: 2px solid var(--vscode-focusBorder);
    }
    .list {
      padding: 10px;
      padding-bottom: 96px;
      display: grid;
      gap: 10px;
    }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-sideBar-background);
    }
    .meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
      opacity: 0.8;
    }
    .path {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      margin-bottom: 8px;
      word-break: break-all;
    }
    .comment {
      margin-bottom: 8px;
      white-space: pre-wrap;
    }
    .code {
      margin: 0;
      background: var(--vscode-editor-background);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      border: 1px solid var(--vscode-panel-border);
    }
    .actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .fixed-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      gap: 8px;
      padding: 10px;
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border);
    }
    .batch-title {
      font-weight: 600;
      margin-bottom: 6px;
    }
    .summary {
      font-size: 12px;
      opacity: 0.9;
      margin-bottom: 8px;
    }
    .hidden {
      display: none;
    }
    .empty {
      opacity: 0.8;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" id="tab-pending">Pending</button>
    <button class="tab" id="tab-reviews">Reviews</button>
  </div>
  <section id="pending-list" class="list"></section>
  <section id="reviews-list" class="list hidden"></section>
  <div id="pending-actions" class="fixed-bar">
    <button id="clear" title="Clear pending comments">Clear</button>
    <button class="primary" id="send" title="Copy and archive pending comments">Send for review</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { pending: [], reviews: [], tab: "pending", expandedBatches: {} };

    const tabPending = document.getElementById("tab-pending");
    const tabReviews = document.getElementById("tab-reviews");
    const pendingList = document.getElementById("pending-list");
    const reviewsList = document.getElementById("reviews-list");
    const pendingActions = document.getElementById("pending-actions");
    const clearBtn = document.getElementById("clear");
    const sendBtn = document.getElementById("send");

    function setTab(tab) {
      state.tab = tab;
      const pendingActive = tab === "pending";
      tabPending.classList.toggle("active", pendingActive);
      tabReviews.classList.toggle("active", !pendingActive);
      pendingList.classList.toggle("hidden", !pendingActive);
      reviewsList.classList.toggle("hidden", pendingActive);
      pendingActions.classList.toggle("hidden", !pendingActive);
    }

    tabPending.addEventListener("click", () => setTab("pending"));
    tabReviews.addEventListener("click", () => setTab("reviews"));
    clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clearPending" }));
    sendBtn.addEventListener("click", () => vscode.postMessage({ type: "sendForReview" }));

    function renderPending() {
      if (!state.pending.length) {
        pendingList.innerHTML = '<div class="empty">No pending comments yet. Use right click or Cmd/Ctrl+Alt+R in the editor.</div>';
        return;
      }
      pendingList.innerHTML = state.pending.map((comment) => renderCommentCard(comment)).join("");
      wireOpenButtons(pendingList);
    }

    function renderReviews() {
      if (!state.reviews.length) {
        reviewsList.innerHTML = '<div class="empty">No review batches yet.</div>';
        return;
      }

      reviewsList.innerHTML = state.reviews.map((batch) => {
        const expanded = Boolean(state.expandedBatches[batch.id]);
        return \`
          <article class="card">
            <div class="batch-title">Batch \${new Date(batch.createdAt).toLocaleString()}</div>
            <div class="summary">\${batch.comments.length} comment(s)</div>
            <div class="actions">
              <button data-roll="\${batch.id}">Rollback</button>
              <button data-expand="\${batch.id}">\${expanded ? "Hide details" : "Show details"}</button>
            </div>
            <div class="\${expanded ? "" : "hidden"}" id="details-\${batch.id}">
              \${batch.comments.map((comment) => renderCommentCard(comment)).join("")}
            </div>
          </article>
        \`;
      }).join("");

      reviewsList.querySelectorAll("[data-roll]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "rollbackBatch", batchId: btn.getAttribute("data-roll") });
        });
      });
      reviewsList.querySelectorAll("[data-expand]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-expand");
          state.expandedBatches[id] = !state.expandedBatches[id];
          renderReviews();
        });
      });
      wireOpenButtons(reviewsList);
    }

    function renderCommentCard(comment) {
      return \`
        <article class="card">
          <div class="meta">
            <span>L\${comment.line}</span>
            <span>\${new Date(comment.createdAt).toLocaleString()}</span>
          </div>
          <div class="path">\${escapeHtml(comment.filePath)}</div>
          <div class="comment">\${escapeHtml(comment.comment)}</div>
          <pre class="code">\${escapeHtml(comment.context.join("\\n"))}</pre>
          <div class="actions">
            <button data-open="\${comment.id}">Go to code</button>
            <button data-edit="\${comment.id}" data-comment="\${encodeURIComponent(comment.comment)}">Edit</button>
          </div>
        </article>
      \`;
    }

    function wireOpenButtons(root) {
      root.querySelectorAll("[data-open]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "openComment", commentId: btn.getAttribute("data-open") });
        });
      });
      root.querySelectorAll("[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const commentId = btn.getAttribute("data-edit");
          const current = decodeURIComponent(btn.getAttribute("data-comment") || "");
          const next = window.prompt("Edit review comment", current);
          if (next !== null) {
            vscode.postMessage({ type: "updateComment", commentId, commentText: next });
          }
        });
      });
    }

    function escapeHtml(text) {
      return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    window.addEventListener("message", (event) => {
      if (event.data?.type === "state") {
        state.pending = event.data.state.pending ?? [];
        state.reviews = event.data.state.reviews ?? [];
        renderPending();
        renderReviews();
      }
    });

    setTab("pending");
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
function deactivate() {
    // no-op
}
//# sourceMappingURL=extension.js.map