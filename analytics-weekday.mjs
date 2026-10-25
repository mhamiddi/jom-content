const WEEKDAYS = [
  ['mon', 'Isn'],
  ['tue', 'Sel'],
  ['wed', 'Rab'],
  ['thu', 'Kha'],
  ['fri', 'Jum'],
  ['sat', 'Sab'],
  ['sun', 'Ahd'],
];

function weekdayIndex(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return -1;
  const [, year, month, day] = match;
  const sundayFirst = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

export function weekdayAverages(posts) {
  const groups = WEEKDAYS.map(([key, label]) => ({ key, label, items: 0, views: 0, avgViews: null }));
  for (const post of Array.isArray(posts) ? posts : []) {
    if (post?.views_missing || post?.views == null || !Number.isFinite(Number(post.views))) continue;
    const index = weekdayIndex(post.date);
    if (index < 0) continue;
    groups[index].items += 1;
    groups[index].views += Number(post.views);
  }
  for (const group of groups) {
    group.avgViews = group.items ? Math.round(group.views / group.items) : null;
  }
  return groups;
}
