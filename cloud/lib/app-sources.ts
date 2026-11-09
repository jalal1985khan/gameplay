// Labels stored in the site column for rounds the app itself writes (not live capture).
// Kept apart from rounds.ts so client components can use it without pulling in the database.
export const APP_SOURCES = {manual: 'manual-entry', import: 'csv-import', sample: 'sample-generator'} as const;
export type AppSource = typeof APP_SOURCES[keyof typeof APP_SOURCES];
