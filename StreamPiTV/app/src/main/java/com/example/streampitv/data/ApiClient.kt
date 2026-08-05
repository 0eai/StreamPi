package com.example.streampitv.data

import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Cached Retrofit clients, keyed by server URL. Previously every screen built its own
 * Retrofit instance per call, which also meant a fresh OkHttp connection pool each time.
 *
 * Two profiles, because the endpoints have wildly different latencies:
 *  - [of]     normal calls (library, progress, media info, status)
 *  - [longOf] /api/media/nas-action, which shells out to curl with --max-time 14400
 */
object ApiClient {
    private val standard = mutableMapOf<String, ApiService>()
    private val long = mutableMapOf<String, ApiService>()

    private val standardHttp: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    private val longHttp: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.MINUTES)
            .writeTimeout(30, TimeUnit.MINUTES)
            .build()
    }

    fun of(serverUrl: String): ApiService = synchronized(standard) {
        standard.getOrPut(serverUrl) { build(serverUrl, standardHttp) }
    }

    fun longOf(serverUrl: String): ApiService = synchronized(long) {
        long.getOrPut(serverUrl) { build(serverUrl, longHttp) }
    }

    private fun build(serverUrl: String, http: OkHttpClient): ApiService =
        Retrofit.Builder()
            .baseUrl(if (serverUrl.endsWith("/")) serverUrl else "$serverUrl/")
            .client(http)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
}
