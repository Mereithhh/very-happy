export interface ChangelogEntry {
    title: string;
    markdown: string;
}

export interface ChangelogData {
    entries: ChangelogEntry[];
    latestTitle: string;
}
