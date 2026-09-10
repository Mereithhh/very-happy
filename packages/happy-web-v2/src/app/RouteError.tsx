import { useRouteError } from 'react-router-dom';
import { ChunkFailure } from './ChunkFailure';
export function RouteError() { return <ChunkFailure error={useRouteError()} />; }
