// `import`: threads the user saved and imported from a file (D50); never read live, never in a source file.
export type Engine = 'discourse' | 'xenforo' | 'phpbb' | 'vbulletin' | 'generic' | 'custom' | 'import';

/**
 * D50: the route an imported file came through, which is all lurkd knows of who imported it:
 * `page` is the upload on the lurkd page, `api` the Bearer route, which `lurkd import reddit` and
 * any agent holding the token use alike, so the two cannot be told apart.
 */
export type ImportVia = 'page' | 'api';

/** D50: how a thread came into the archive from a saved file, kept with the thread. */
export interface ImportProvenance {
  via: ImportVia;
  /** When the import this one replaced was made, or null for the first import of the thread. */
  replacedImportAt: string | null;
}

export interface ExtractedPost {
  number: number;
  page: number | null;
  // The real username, not a pseudonym.
  author: string;
  authorUrl: string | null;
  signals: string[];
  notes: string[];
  postedAt: string | null;
  // Markdown body; carries the name markers that Task 5 defines.
  bodyMd: string;
}

export interface ExtractedThread {
  url: string;
  title: string;
  engine: Engine;
  postsExpected: number | null;
  pages: number | null;
  extraction: string;
  quality: 'full' | 'low';
  posts: ExtractedPost[];
}

export interface SearchHit {
  url: string;
  title: string;
  posts: number | null;
}

export interface AuthorSignals {
  postCount: number | null;
  joinedAt: string | null;
  extra: string[];
}
