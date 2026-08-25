import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WhyVeryHappy } from './WhyVeryHappy';

describe('WhyVeryHappy', () => {
  it('renders four concise friction-to-outcome routes as one semantic list', () => {
    const html = renderToStaticMarkup(<WhyVeryHappy />);

    expect(html).toContain('role="list"');
    expect(html.match(/role="listitem"/g)).toHaveLength(4);
    expect(html).toContain('One panel holds the fleet.');
    expect(html).toContain('Structured when useful. Native when necessary.');
    expect(html).toContain('Carry the work between screens.');
    expect(html).toContain('Choose the operator—not another silo.');
    expect(html).not.toContain('better than');
    expect(html).not.toContain('trusted by');
  });
});
