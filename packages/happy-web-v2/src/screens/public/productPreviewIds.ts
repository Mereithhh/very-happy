export type ProductPreviewView = 'terminal' | 'conversation' | 'board';

export function getProductPreviewIds(instanceId: string) {
  return {
    panel: `${instanceId}-product-panel`,
    files: `${instanceId}-product-files`,
  };
}
