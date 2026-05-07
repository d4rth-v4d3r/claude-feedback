"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const node_child_process_1 = require("node:child_process");
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
        this.branchCache = new Map();
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
        const metadata = this.getLocationMetadata(document.uri);
        const newComment = {
            id: makeId(),
            filePath: document.uri.fsPath,
            relativePath: metadata.relativePath,
            line: lineNumber,
            comment: input.trim(),
            context: contextLines,
            repoName: metadata.repoName,
            repoPath: metadata.repoPath,
            worktreeName: metadata.worktreeName,
            workspaceFolderPath: metadata.workspaceFolderPath,
            branchName: metadata.branchName,
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
        const allComments = [
            ...this.state.pending.map((comment) => this.normalizeComment(comment)),
            ...this.state.reviews.flatMap((batch) => batch.comments.map((comment) => this.normalizeComment(comment))),
        ];
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
        const pending = this.state.pending
            .map((comment) => this.normalizeComment(comment))
            .filter((comment) => this.isWorkspaceVisible(comment.workspaceFolderPath));
        const reviews = this.state.reviews
            .map((batch) => ({
            ...batch,
            comments: batch.comments
                .map((comment) => this.normalizeComment(comment))
                .filter((comment) => this.isWorkspaceVisible(comment.workspaceFolderPath)),
        }))
            .filter((batch) => batch.comments.length > 0);
        this.view?.webview.postMessage({
            type: "state",
            state: { pending, reviews },
        });
    }
    normalizeComment(comment) {
        if (comment.relativePath &&
            comment.repoName &&
            comment.repoPath &&
            comment.worktreeName &&
            comment.workspaceFolderPath &&
            comment.branchName) {
            return comment;
        }
        const metadata = this.getLocationMetadata(vscode.Uri.file(comment.filePath));
        return {
            ...comment,
            relativePath: comment.relativePath ?? metadata.relativePath,
            repoName: comment.repoName ?? metadata.repoName,
            repoPath: comment.repoPath ?? metadata.repoPath,
            worktreeName: comment.worktreeName ?? metadata.worktreeName,
            workspaceFolderPath: comment.workspaceFolderPath ?? metadata.workspaceFolderPath,
            branchName: comment.branchName ?? metadata.branchName,
        };
    }
    isWorkspaceVisible(workspaceFolderPath) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.some((folder) => folder.uri.fsPath === workspaceFolderPath);
    }
    getLocationMetadata(uri) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const workspaceFolderPath = workspaceFolder?.uri.fsPath ?? path.dirname(uri.fsPath);
        const relativePath = workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath) : path.basename(uri.fsPath);
        const repoPath = this.findGitRoot(path.dirname(uri.fsPath)) ?? workspaceFolderPath;
        const repoName = path.basename(repoPath);
        const worktreeName = path.basename(workspaceFolderPath);
        const branchName = this.getBranchName(repoPath);
        return { relativePath, repoName, repoPath, worktreeName, workspaceFolderPath, branchName };
    }
    findGitRoot(startDir) {
        let current = startDir;
        while (true) {
            if (fs.existsSync(path.join(current, ".git"))) {
                return current;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return undefined;
            }
            current = parent;
        }
    }
    getBranchName(repoPath) {
        const cached = this.branchCache.get(repoPath);
        if (cached) {
            return cached;
        }
        try {
            const branch = (0, node_child_process_1.execSync)("git rev-parse --abbrev-ref HEAD", {
                cwd: repoPath,
                stdio: ["ignore", "pipe", "ignore"],
                encoding: "utf8",
            }).trim();
            const resolved = branch || "detached";
            this.branchCache.set(repoPath, resolved);
            return resolved;
        }
        catch {
            this.branchCache.set(repoPath, "unknown");
            return "unknown";
        }
    }
}
function makeId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function buildReviewCopyText(comments) {
    const lines = comments.map((item, index) => `  ${index + 1}. @${item.filePath} L${item.line}: ${item.comment}`);
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
    * {
      box-sizing: border-box;
      min-width: 0;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      overflow-x: hidden;
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
      max-width: 100%;
      overflow: hidden;
    }
    .meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
      opacity: 0.8;
    }
    .path-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .path-link:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
    .comment {
      margin-bottom: 8px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .code {
      margin: 0;
      background: var(--vscode-editor-background);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      max-width: 100%;
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
    .fixed-bar > button {
      flex: 1;
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
    .editor-row {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .editor-input {
      width: 100%;
      min-height: 64px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .tree-group {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--vscode-sideBar-background);
    }
    .tree-summary {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--vscode-foreground);
      text-align: left;
      font-weight: 600;
      padding: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
    }
    .tree-children {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 8px;
      display: grid;
      gap: 8px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      padding: 1px 8px;
      opacity: 0.9;
      white-space: nowrap;
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
    const state = {
      pending: [],
      reviews: [],
      tab: "pending",
      expandedBatches: {},
      expandedRepos: {},
      expandedWorktrees: {},
      editingCommentId: null
    };

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
      const grouped = groupPending(state.pending);
      pendingList.innerHTML = grouped.map((repoGroup) => {
        const repoKey = repoGroup.repoName;
        const repoOpen = state.expandedRepos[repoKey] ?? true;
        return \`
          <section class="tree-group">
            <button class="tree-summary" data-toggle-repo="\${escapeHtml(repoKey)}">
              <span>\${repoOpen ? "▾" : "▸"} \${escapeHtml(repoGroup.repoName)}</span>
              <span class="badge">\${repoGroup.count} comment(s)</span>
            </button>
            <div class="\${repoOpen ? "tree-children" : "hidden"}">
              \${repoGroup.worktrees.map((worktreeGroup) => {
                const worktreeKey = \`\${repoKey}::\${worktreeGroup.worktreeName}\`;
                const worktreeOpen = state.expandedWorktrees[worktreeKey] ?? true;
                return \`
                  <section class="tree-group">
                    <button class="tree-summary" data-toggle-worktree="\${escapeHtml(worktreeKey)}">
                      <span>\${worktreeOpen ? "▾" : "▸"} \${escapeHtml(worktreeGroup.worktreeName)}</span>
                      <span class="badge">\${escapeHtml(worktreeGroup.branchName)}</span>
                    </button>
                    <div class="\${worktreeOpen ? "tree-children" : "hidden"}">
                      \${worktreeGroup.comments.map((comment) => renderCommentCard(comment)).join("")}
                    </div>
                  </section>
                \`;
              }).join("")}
            </div>
          </section>
        \`;
      }).join("");
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
      const isEditing = state.editingCommentId === comment.id;
      return \`
        <article class="card">
          <div class="meta">
            <span>L\${comment.line}</span>
            <span>\${new Date(comment.createdAt).toLocaleString()}</span>
          </div>
          <a class="path-link" data-open="\${comment.id}">
            <span>✎</span>
            <span>\${escapeHtml(comment.relativePath)}:\${comment.line}</span>
          </a>
          <div class="comment">\${escapeHtml(comment.comment)}</div>
          <pre class="code">\${escapeHtml(comment.context.join("\\n"))}</pre>
          <div class="actions">
            <button data-edit="\${comment.id}">\${isEditing ? "Close" : "Edit"}</button>
          </div>
          <div class="\${isEditing ? "editor-row" : "hidden"}">
            <textarea class="editor-input" data-editor="\${comment.id}">\${escapeHtml(comment.comment)}</textarea>
            <div class="actions">
              <button class="primary" data-save="\${comment.id}">Save</button>
            </div>
          </div>
        </article>
      \`;
    }

    function wireOpenButtons(root) {
      root.querySelectorAll("[data-toggle-repo]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-toggle-repo");
          state.expandedRepos[key] = !(state.expandedRepos[key] ?? true);
          renderPending();
        });
      });
      root.querySelectorAll("[data-toggle-worktree]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-toggle-worktree");
          state.expandedWorktrees[key] = !(state.expandedWorktrees[key] ?? true);
          renderPending();
        });
      });
      root.querySelectorAll("[data-open]").forEach((btn) => {
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "openComment", commentId: btn.getAttribute("data-open") });
        });
      });
      root.querySelectorAll("[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const commentId = btn.getAttribute("data-edit");
          state.editingCommentId = state.editingCommentId === commentId ? null : commentId;
          renderPending();
          renderReviews();
        });
      });
      root.querySelectorAll("[data-save]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const commentId = btn.getAttribute("data-save");
          const input = root.querySelector(\`[data-editor="\${commentId}"]\`);
          if (!input) {
            return;
          }
          const next = input.value ?? "";
          vscode.postMessage({ type: "updateComment", commentId, commentText: next });
          state.editingCommentId = null;
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

    function groupPending(comments) {
      const repoMap = new Map();
      for (const comment of comments) {
        const repoName = comment.repoName || "Unknown Repo";
        const worktreeName = comment.worktreeName || "Unknown Worktree";
        const repoGroup = repoMap.get(repoName) || { repoName, count: 0, worktreeMap: new Map() };
        repoGroup.count += 1;
        const worktreeGroup =
          repoGroup.worktreeMap.get(worktreeName) ||
          { worktreeName, branchName: comment.branchName || "unknown", comments: [] };
        worktreeGroup.comments.push(comment);
        repoGroup.worktreeMap.set(worktreeName, worktreeGroup);
        repoMap.set(repoName, repoGroup);
      }

      return Array.from(repoMap.values()).map((repoGroup) => ({
        repoName: repoGroup.repoName,
        count: repoGroup.count,
        worktrees: Array.from(repoGroup.worktreeMap.values()),
      }));
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