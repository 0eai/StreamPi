/**
 * Builds the `-headers` value ffmpeg and ffprobe need to authenticate against a NAS node.
 *
 * This exists because the same one-line string was written out by hand in six places and two of them
 * had a trailing `\r\n`, which silently broke them. ffmpeg strips a trailing `\n` and appends its own
 * `\r\n`, so the request goes out as:
 *
 *     Authorization: Bearer <key>\r\r\n
 *
 * — a header whose value ends in a bare CR. Node's HTTP parser answers 400 before serving a byte, and
 * ffmpeg reports only "Server returned 400 Bad Request", which looks like an auth or URL problem rather
 * than a malformed request. Captured off the wire to be sure of the mechanism.
 *
 * The consequence was that every poster extraction for a NAS-resident file failed instantly and
 * permanently, while the ffprobe call beside it — written without the CRLF — always worked. That is why
 * such rows carried a correct duration and no poster at all.
 *
 * The CRLF is a separator *between* header lines. Only use it if more headers follow, and never on the
 * last one.
 */
export const ffmpegAuthHeader = (apiKey) => `Authorization: Bearer ${apiKey}`;
