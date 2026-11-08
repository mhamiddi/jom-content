import { serveMedia } from '../_lib/threads-media.js';
// Public GET/HEAD only, checksum-addressed media. Meta must fetch without a cookie.
export function onRequest({request,env}) { return serveMedia(request,env); }
