/**
 * Placeholder shim for @expo/vector-icons. Real web iconography is introduced in
 * P2/P3 (a token-styled <Icon> backed by inline SVG). For now every icon family
 * renders an empty inline-block so layout is preserved and the data layer compiles.
 */
import type { CSSProperties } from 'react';

interface IconProps {
  name?: string;
  size?: number;
  color?: string;
  style?: CSSProperties;
}

function makeFamily() {
  return function Icon({ size = 16, color = 'currentColor', style }: IconProps) {
    return (
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          color,
          ...style,
        }}
      />
    );
  };
}

export const Ionicons = makeFamily();
export const Octicons = makeFamily();
export const MaterialIcons = makeFamily();
export const MaterialCommunityIcons = makeFamily();
export const Feather = makeFamily();
export const FontAwesome = makeFamily();
export const FontAwesome5 = makeFamily();
export const AntDesign = makeFamily();
export const Entypo = makeFamily();
export const EvilIcons = makeFamily();
export const Foundation = makeFamily();
export const SimpleLineIcons = makeFamily();
export const Zocial = makeFamily();
export const Fontisto = makeFamily();

export default {
  Ionicons,
  Octicons,
  MaterialIcons,
  MaterialCommunityIcons,
  Feather,
  FontAwesome,
};
