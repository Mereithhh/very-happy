import { StartupLoader } from './StartupLoader';

export interface OrbitLoaderProps {
  size?: 'compact' | 'medium' | 'large';
  label?: string;
  showWordmark?: boolean;
  presentation?: boolean;
  className?: string;
}

/** Kept as the shared loading API; all consumers now use the brand connection style. */
export function OrbitLoader({size='compact',label='Loading Very Happy',showWordmark=false,presentation=false,className}:OrbitLoaderProps) {
  return <StartupLoader compact={size==='compact'} label={label} showWordmark={showWordmark} presentation={presentation} className={`vh-orbit-widget${className?' '+className:''}`}/>;
}
