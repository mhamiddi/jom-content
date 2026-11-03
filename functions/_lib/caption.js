// TikTok plans keep the video script in `caption`; the text that goes under the
// video lives in `postCaption`. Threads plans post `caption` as is.
export function publishCaption(post) {
  if (!post) return '';
  return String((post.platform === 'tiktok' ? post.postCaption : post.caption) || '').trim();
}

export const MISSING_POST_CAPTION = 'Caption post kosong. Tekan Edit post dan isi "Caption post". Skrip TikTok tak dihantar sebagai caption.';
