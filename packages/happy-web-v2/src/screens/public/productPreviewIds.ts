export type ProductPreviewView = 'terminal' | 'conversation' | 'board';

export function getProductPreviewIds(instanceId: string) {
  return {
    panel: `${instanceId}-product-panel`,
    files: `${instanceId}-product-files`,
    tabs: {
      terminal: `${instanceId}-product-tab-terminal`,
      conversation: `${instanceId}-product-tab-conversation`,
      board: `${instanceId}-product-tab-board`,
    } satisfies Record<ProductPreviewView, string>,
  };
}
