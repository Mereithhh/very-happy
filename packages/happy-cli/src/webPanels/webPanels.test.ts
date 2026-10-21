import { describe, expect, it } from 'vitest'
import { normalizeWebPanels, webPanelPath, webPanelsSignature, webPanelUrlProblem, WEB_PANEL_LIMIT } from './webPanels'

describe('B-510 normalizeWebPanels', () => {
    it('keeps valid https and loopback-http panels, defaults title and embed', () => {
        const { panels, problems } = normalizeWebPanels([
            { id: 'desktop', title: '桌面', url: 'https://dev-sg.example.ts.net:6443/vnc.html?autoconnect=1' },
            { id: 'dev', url: 'http://localhost:5173', embed: false },
        ])
        expect(problems).toEqual([])
        expect(panels).toEqual([
            { id: 'desktop', title: '桌面', url: 'https://dev-sg.example.ts.net:6443/vnc.html?autoconnect=1', embed: true },
            { id: 'dev', title: 'dev', url: 'http://localhost:5173/', embed: false },
        ])
    })

    it('skips and reports: bad id, duplicate, plain http to a LAN host, userinfo, non-URL, over the limit', () => {
        const many = Array.from({ length: WEB_PANEL_LIMIT + 1 }, (_, i) => ({ id: `p${i}`, url: `https://h${i}.example.com/` }))
        const { panels, problems } = normalizeWebPanels([
            { id: 'Bad_ID', url: 'https://a.example.com' },
            { id: 'x', url: 'http://100.64.1.2:6080/' },
            { id: 'y', url: 'https://user:pw@a.example.com/' },
            { id: 'z', url: 'not a url' },
            ...many,
            { id: 'p0', url: 'https://dup.example.com/' },
        ])
        expect(panels.map((p) => p.id)).toEqual(many.slice(0, WEB_PANEL_LIMIT).map((p) => p.id))
        expect(problems.map((p) => p.reason)).toEqual([
            'id must match ^[a-z0-9][a-z0-9-]{0,31}$',
            'url must be https:// (http:// only for localhost)',
            'url must not contain credentials',
            'url is not a valid URL',
            `more than ${WEB_PANEL_LIMIT} panels`,
            'duplicate id',
        ])
    })

    it('a missing key is no panels and no problems; a non-array is one problem', () => {
        expect(normalizeWebPanels(undefined)).toEqual({ panels: [], problems: [] })
        expect(normalizeWebPanels({ id: 'a' }).problems).toHaveLength(1)
    })

    it('signature changes with any field and ignores nothing else', () => {
        const a = normalizeWebPanels([{ id: 'a', url: 'https://a.example.com' }]).panels
        const b = normalizeWebPanels([{ id: 'a', url: 'https://a.example.com', embed: false }]).panels
        expect(webPanelsSignature(a)).toBe(webPanelsSignature(normalizeWebPanels([{ id: 'a', url: 'https://a.example.com/' }]).panels))
        expect(webPanelsSignature(a)).not.toBe(webPanelsSignature(b))
    })

    it('url rules and the deep link', () => {
        expect(webPanelUrlProblem('http://127.0.0.1:4849/')).toBeNull()
        expect(webPanelUrlProblem('ftp://a.example.com')).toMatch(/https/)
        expect(webPanelPath('m 1', 'desktop')).toBe('/machine/m%201/panel/desktop')
    })
})
