#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';

interface ChangelogEntry {
    title: string;
    markdown: string;
}

interface ChangelogData {
    entries: ChangelogEntry[];
    latestTitle: string;
}

function parseChangelog(): ChangelogData {
    const changelogPath = path.join(__dirname, '../../CHANGELOG.md');

    if (!fs.existsSync(changelogPath)) {
        console.warn('CHANGELOG.md not found');
        return { entries: [], latestTitle: '' };
    }

    const content = fs.readFileSync(changelogPath, 'utf-8');
    const entries: ChangelogEntry[] = [];

    // Split on # headers (h1 only)
    const sections = content.split(/^# /gm).filter(s => s.trim());

    for (const section of sections) {
        const newlineIndex = section.indexOf('\n');
        if (newlineIndex === -1) continue;

        const title = section.slice(0, newlineIndex).trim();
        const markdown = section.slice(newlineIndex + 1).trim();
        if (!markdown) continue;

        entries.push({ title, markdown });
    }

    const latestTitle = entries.length > 0 ? entries[0].title : '';

    return { entries, latestTitle };
}

function main() {
    console.log('Parsing CHANGELOG.md...');

    const changelogData = parseChangelog();
    const outputPath = path.join(__dirname, '../changelog/changelog.json');

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(changelogData, null, 2));

    console.log(`Parsed ${changelogData.entries.length} entries`);
    console.log(`Latest: ${changelogData.latestTitle}`);
}

if (require.main === module) {
    main();
}

export { parseChangelog };
