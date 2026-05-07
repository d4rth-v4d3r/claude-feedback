import * as vscode from "vscode";
import * as path from "node:path";
import type { ReviewBatch, ReviewComment } from "./types";
import type { ReviewStore } from "./store";

export type ResolvedTreeItem = BatchNode | BatchFileNode;

export class BatchNode {
  readonly kind = "batch" as const;
  constructor(readonly batch: ReviewBatch) {}
}

export class BatchFileNode {
  readonly kind = "batchFile" as const;
  constructor(
    readonly batchId: string,
    readonly filePath: string,
    readonly relativePath: string,
    readonly comments: ReviewComment[]
  ) {}
}

/**
 * Tree of historical review batches. Top level is each batch (in
 * reverse-chronological order); expanding shows the unique files
 * touched by that batch. Click on a file opens the live file (it is
 * historical so we don't try to recreate threads — they're encoded
 * in the batch's `copiedText` for audit).
 */
export class ResolvedTreeProvider implements vscode.TreeDataProvider<ResolvedTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ResolvedTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore) {
    this.subscriptions.push(this.store.onDidChange(() => this.emitter.fire()));
  }

  dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
    this.emitter.dispose();
  }

  getTreeItem(element: ResolvedTreeItem): vscode.TreeItem {
    return element.kind === "batch" ? batchTreeItem(element) : fileTreeItem(element);
  }

  getChildren(element?: ResolvedTreeItem): ResolvedTreeItem[] {
    if (!element) {
      return this.store.getState().reviews.map((b) => new BatchNode(b));
    }
    if (element.kind === "batch") {
      const fileMap = new Map<string, { relativePath: string; comments: ReviewComment[] }>();
      for (const c of element.batch.comments) {
        const entry = fileMap.get(c.filePath) ?? { relativePath: c.relativePath, comments: [] };
        entry.comments.push(c);
        fileMap.set(c.filePath, entry);
      }
      return Array.from(fileMap.entries()).map(
        ([fp, info]) => new BatchFileNode(element.batch.id, fp, info.relativePath, info.comments)
      );
    }
    return [];
  }
}

function batchTreeItem(node: BatchNode): vscode.TreeItem {
  const date = new Date(node.batch.createdAt);
  const item = new vscode.TreeItem(
    `Batch · ${date.toLocaleString()}`,
    vscode.TreeItemCollapsibleState.Collapsed
  );
  item.iconPath = new vscode.ThemeIcon("history");
  const total = node.batch.comments.length;
  item.description = total === 1 ? "1 comment" : `${total} comments`;
  item.contextValue = "codeReview.batch";
  item.tooltip = node.batch.copiedText;
  item.id = `batch-${node.batch.id}`;
  return item;
}

function fileTreeItem(node: BatchFileNode): vscode.TreeItem {
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
