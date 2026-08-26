/** Capability-driven label: old terminal daemons remain title-only. */
export function rowRenameMenuTranslationKeys(
  supportsTags: boolean,
): readonly ['common.rename'] | readonly ['common.rename', 'renameModal.tagsLabel'] {
  return supportsTags ? ['common.rename', 'renameModal.tagsLabel'] : ['common.rename'];
}
