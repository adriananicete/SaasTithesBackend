// Seeded into every new church so its admin is not blocked on day one — an
// empty category list makes RF creation and manual expenses impossible.
// These are a starting point, not a fixture: the church's admin renames,
// adds and archives freely afterwards, and no code assumes any of them exist.
export const STARTER_CATEGORIES = [
    { name: 'Ministry Supplies', color: 'blue' },
    { name: 'Utilities', color: 'amber' },
    { name: 'Repairs & Maintenance', color: 'slate' },
    { name: 'Events & Programs', color: 'violet' },
    { name: 'Transportation', color: 'emerald' },
    { name: 'Others', color: 'rose' },
];

// Both category types get the same starting list — a church requests funds for
// roughly the same things it books expenses against.
export const CATEGORY_TYPES = ['rf', 'expense'];
