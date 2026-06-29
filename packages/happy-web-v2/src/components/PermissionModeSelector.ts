// Shim: the data layer only needs the permission/model mode *types*.
// The real selector UI is rebuilt natively in P3 (web). Types live in modelModeOptions.
export type {
  PermissionMode,
  ModelMode,
  PermissionModeKey,
  ModelModeKey,
} from './modelModeOptions';
