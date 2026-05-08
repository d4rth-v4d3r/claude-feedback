import * as vscode from "vscode";

/**
 * Minimal subset of `vscode.git`'s `API` (version 1) that we use. The full
 * shape lives in the vscode-git extension's `git.d.ts`; we redeclare the
 * pieces we need so we don't take a dependency on a copy of that file.
 */
export interface GitAPI {
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  /** Present on vscode.git API v1 — used to refresh the pending tree when repos are added. */
  readonly onDidOpenRepository?: vscode.Event<GitRepository>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly HEAD?: { name?: string } };
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  getConfig(key: string): Promise<string>;
  setConfig(key: string, value: string): Promise<string>;
  /** Present on real vscode.git repos — fire when HEAD, index, or working tree changes. */
  readonly onDidChangeState?: vscode.Event<unknown>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) {
    return undefined;
  }
  if (!ext.isActive) {
    try {
      await ext.activate();
    } catch {
      return undefined;
    }
  }
  try {
    return ext.exports.getAPI(1);
  } catch {
    return undefined;
  }
}
