import type { Dispatch } from 'react';
import type { ImageForgeAdapter } from '../adapters/imageForgeAdapter';
import type { AppAction, AppState } from '../domain/types';

export interface ScreenProps {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  adapter: ImageForgeAdapter;
  batchStartPending?: boolean;
}
