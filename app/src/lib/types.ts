// Shape of a record in data/processed/reviews.json — what build-dataset.mjs
// emits as the "slim" public dataset.

export interface Author {
  id: string | null;
  name: string | null;
  url: string | null;
  email?: string | null;
  inferred?: boolean;
}

export interface Factbox {
  tittel: string | null;
  originaltittel: string | null;
  regi: string | null;
  serieskaper: string | null;
  manus: string | null;
  skuespillere: string[] | null;
  distributor: string | null;
  sjanger: string[] | null;
  lengde: string | null;
  lengdeMinutes: number | null;
  aldersgrense: string | null;
  norgespremiere: string | null;        // ISO date
  norgespremiereRaw?: string | null;
  produksjonsAr: string | null;
  land: string[] | null;
  sprak: string | null;
  produsent: string | null;
  foto: string | null;
  musikk: string | null;
  klipp: string | null;
  basertPa: string | null;
  utgiver?: string | null;
  spillselskap?: string | null;
}

export interface Review {
  id: string;
  url: string;
  type: 'Movie' | 'TVSeries' | 'Game' | 'VideoGame' | string;
  name: string;
  originalTitle: string | null;
  headline: string | null;
  abstract: string | null;
  rating: number | null;                 // 1..6
  ratingMax: number;
  publishedAt: string | null;            // ISO
  modifiedAt: string | null;             // ISO
  author: Author | null;
  image: string | null;
  section: string | null;
  platform: string | null;               // Kino | Netflix | distributor
  reviewType: string | null;             // Film | Serie | Spill
  factbox: Factbox;
  wordCount: number;
}

export interface ReviewIndexEntry extends Review {
  year: number;                          // derived
  decade: number;                        // derived
  slug: string;                          // url slug
  searchHaystack: string;                // lowercased concat for client search
}

export type SortKey = 'newest' | 'oldest' | 'rating-high' | 'rating-low' | 'a-z' | 'z-a';

export interface ActiveFilters {
  q: string;
  ratings: Set<number>;
  types: Set<string>;            // 'Movie' | 'TVSeries' | 'Game'
  yearMin: number | null;
  yearMax: number | null;
  genres: Set<string>;            // lowercased
  director: string;
  actor: string;
  sort: SortKey;
}
