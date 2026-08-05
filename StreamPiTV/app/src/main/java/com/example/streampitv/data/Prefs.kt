package com.example.streampitv.data

import android.content.Context
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore

val Context.dataStore by preferencesDataStore(name = "settings")

object Prefs {
    val SERVER_URL = stringPreferencesKey("server_url")
    val AUTH_TOKEN = stringPreferencesKey("auth_token")

    // Both /api/auth/login and /api/auth/kunji/finalize return username and role, and they
    // are the only place those are handed out. Stored so the settings screen still has
    // something to show on servers without /api/auth/me.
    val USERNAME = stringPreferencesKey("username")
    val ROLE = stringPreferencesKey("role")
}
