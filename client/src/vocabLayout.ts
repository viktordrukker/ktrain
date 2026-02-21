export type VocabWorkspaceMode = "studio" | "table" | "split";

export function canUseSplitMode(viewportWidth: number, isMobile: boolean): boolean {
  return !isMobile && Number(viewportWidth || 0) >= 1200;
}

export function resolveWorkspaceMode(
  preferredMode: VocabWorkspaceMode,
  viewportWidth: number,
  isMobile: boolean
): VocabWorkspaceMode {
  if (preferredMode !== "split") return preferredMode;
  return canUseSplitMode(viewportWidth, isMobile) ? "split" : "studio";
}

export function computeVocabularyGridTemplate(params: {
  mode: VocabWorkspaceMode;
  viewportWidth: number;
  isMobile: boolean;
  leftPanePercent: number;
  rightPanePercent: number;
  inspectorMaximized: boolean;
}): string | undefined {
  const resolvedMode = resolveWorkspaceMode(params.mode, params.viewportWidth, params.isMobile);
  if (params.isMobile) return undefined;
  if (params.inspectorMaximized) {
    return `minmax(240px, ${params.leftPanePercent}%) minmax(0, ${100 - params.leftPanePercent}%)`;
  }
  if (resolvedMode === "split") {
    return `minmax(240px, ${params.leftPanePercent}%) 10px minmax(0, ${100 - params.leftPanePercent - params.rightPanePercent}%) 10px minmax(360px, ${params.rightPanePercent}%)`;
  }
  return `minmax(240px, ${params.leftPanePercent}%) 10px minmax(0, ${100 - params.leftPanePercent}%)`;
}

