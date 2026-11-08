// The server computes this fingerprint; client-supplied approval flags are never trusted.
// It binds CONTENT, not post.updatedAt: publishing the same post to another platform bumps
// updatedAt and must not silently invalidate an otherwise identical owner approval.
export async function approvalDigest(post, account, body) {
  const version = JSON.stringify({
    schema: 2, id: post.id, accountId: account.id, userId: account.userId,
    caption: body.caption, mediaUrl: body.mediaUrl ?? '', mediaType: body.mediaType ?? '',
    carouselImages: body.carouselImages ?? [],
    savedCaption: post.caption ?? '', savedPostCaption: post.postCaption ?? '',
    savedImages: post.images ?? [],
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function approvalKey(postId, accountId) {
  return `threads_approval:${encodeURIComponent(postId)}:${encodeURIComponent(accountId)}`;
}
