"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResolvedTreeProvider = exports.BatchFileNode = exports.BatchNode = void 0;
const vscode = require("vscode");
const path = require("node:path");
class BatchNode {
    constructor(batch) {
        this.batch = batch;
        this.kind = "batch";
    }
}
exports.BatchNode = BatchNode;
class BatchFileNode {
    constructor(batchId, filePath, relativePath, comments) {
        this.batchId = batchId;
        this.filePath = filePath;
        this.relativePath = relativePath;
        this.comments = comments;
        this.kind = "batchFile";
    }
}
exports.BatchFileNode = BatchFileNode;
/**
 * Tree of historical review batches. Top level is each batch (in
 * reverse-chronological order); expanding shows the unique files
 * touched by that batch. Click on a file opens the live file (it is
 * historical so we don't try to recreate threads — they're encoded
 * in the batch's `copiedText` for audit).
 */
class ResolvedTreeProvider {
    constructor(store) {
        this.store = store;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        this.subscriptions = [];
        this.subscriptions.push(this.store.onDidChange(() => this.emitter.fire()));
    }
    dispose() {
        vscode.Disposable.from(...this.subscriptions).dispose();
        this.emitter.dispose();
    }
    getTreeItem(element) {
        return element.kind === "batch" ? batchTreeItem(element) : fileTreeItem(element);
    }
    getChildren(element) {
        if (!element) {
            return this.store.getState().reviews.map((b) => new BatchNode(b));
        }
        if (element.kind === "batch") {
            const fileMap = new Map();
            for (const c of element.batch.comments) {
                const entry = fileMap.get(c.filePath) ?? { relativePath: c.relativePath, comments: [] };
                entry.comments.push(c);
                fileMap.set(c.filePath, entry);
            }
            return Array.from(fileMap.entries()).map(([fp, info]) => new BatchFileNode(element.batch.id, fp, info.relativePath, info.comments));
        }
        return [];
    }
}
exports.ResolvedTreeProvider = ResolvedTreeProvider;
function batchTreeItem(node) {
    const date = new Date(node.batch.createdAt);
    const item = new vscode.TreeItem(`Batch · ${date.toLocaleString()}`, vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon("history");
    const total = node.batch.comments.length;
    item.description = total === 1 ? "1 comment" : `${total} comments`;
    item.contextValue = "codeReview.batch";
    item.tooltip = node.batch.copiedText;
    item.id = `batch-${node.batch.id}`;
    return item;
}
function fileTreeItem(node) {
    const fileName = path.basename(node.filePath);
    const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(node.filePath);
    item.description = node.relativePath !== fileName ? node.relativePath : undefined;
    item.contextValue = "codeReview.batchFile";
    item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [vscode.Uri.file(node.filePath)],
    };
    return item;
}
//# sourceMappingURL=resolvedTreeProvider.js.map