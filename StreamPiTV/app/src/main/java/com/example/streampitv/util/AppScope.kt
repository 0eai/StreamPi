package com.example.streampitv.util

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Process-lifetime scope for fire-and-forget work that must outlive the composable triggering it.
 *
 * Exists for exactly one case: telling the server to release a stream when the player closes.
 * `rememberCoroutineScope()` is cancelled at precisely the moment `onDispose` runs, so a request
 * launched there is cancelled before it reaches the wire — the call silently never happens.
 *
 * Deliberately un-scoped, with a SupervisorJob so one failure can't take anything else down.
 * Anything beyond fire-and-forget teardown wants a real lifecycle owner instead.
 */
object AppScope : CoroutineScope by CoroutineScope(SupervisorJob() + Dispatchers.IO)
