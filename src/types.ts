export type Engine = 'discourse' | 'xenforo' | 'phpbb' | 'vbulletin' | 'generic' | 'custom';

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
