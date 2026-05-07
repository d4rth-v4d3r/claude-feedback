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
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly HEAD?: { name?: string } };
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  getConfig(key: string): Promise<string>;
  setConfig(key: string, value: string): Promise<string>;
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
