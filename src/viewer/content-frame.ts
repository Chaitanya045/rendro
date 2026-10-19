/**
 * Fired on the shell's window when another iframe becomes `#content-frame` (an adopted preload,
 * #245); `detail` is the new frame. Scripts that hold the frame element follow it (#254).
 */
export const CONTENT_FRAME_EVENT = "rendro:content-frame";
