import { Monitor, Server, Smartphone, Tv } from 'lucide-react';

/**
 * Icon per `deviceKind` as normalized by the server (see deviceKindOf in routes/auth.js) — never
 * off the raw `device_type`, which is whatever a client claimed at login and disagrees between
 * the TV app's two login paths and the web client's own user-agent sniffing.
 *
 * CastModal and DashboardTab still carry their own variants of this mapping; switching them over
 * is a small follow-up, deliberately left out of the change that added this.
 */
export const DEVICE_ICON = {
    tv: Tv,
    mobile: Smartphone,
    desktop: Monitor,
    server: Server,
};

export const deviceIcon = (kind) => DEVICE_ICON[kind] || Monitor;
