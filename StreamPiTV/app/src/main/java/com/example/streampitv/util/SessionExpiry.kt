package com.example.streampitv.util

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * A 401 on a request that *carried* a credential means that credential is dead.
 *
 * A 401 on a request with no `Authorization` header is something else entirely — POST
 * /api/auth/login answers 401 for a wrong password — and must never trigger a sign-out, or
 * every typo at the login screen would look like an expiring session.
 */
fun isSessionExpiry(code: Int, hadAuthHeader: Boolean): Boolean = code == 401 && hadAuthHeader

/**
 * Broadcasts "the stored session token is no longer accepted" from the networking layer up to
 * whoever owns navigation.
 *
 * The server deletes session rows after 7 days of inactivity (server.js), after which
 * verifyToken answers 401 for everything. Before this existed, HomeScreen caught that 401,
 * logged it, and left `library` null — an infinite spinner. The dead token stayed in DataStore,
 * so relaunching replayed the same loop and the only way out was reinstalling the app.
 *
 * Signalled from a single OkHttp interceptor in [com.example.streampitv.data.ApiClient] so no
 * individual call site has to remember to handle it.
 *
 * IMPORTANT: this is safe only because ExoPlayer does **not** share the app's OkHttp client —
 * there is no DataSource.Factory anywhere, so media requests go through DefaultHttpDataSource.
 * PlayerScreen treats a mid-playback 401 as routine and re-mints its short-lived stream token;
 * if anyone ever routes ExoPlayer through OkHttpDataSource, those routine 401s would reach this
 * and start signing people out in the middle of a film.
 */
object SessionExpiry {
    // extraBufferCapacity = 1 so tryEmit from an interceptor thread never drops the first
    // signal for want of a collector, and never blocks. Repeats are harmless: the collector
    // ignores a signal once the token is already gone.
    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val events: SharedFlow<Unit> = _events

    fun signal() {
        _events.tryEmit(Unit)
    }
}
